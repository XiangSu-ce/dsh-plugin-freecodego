/**
 * The team tool surface: a board you can claim from, members you can start,
 * merge, and recover, and manual control over the parent's own context.
 *
 * This module is the only place where a *model* touches the team machinery, so
 * it is also where the safety of doing so is decided:
 *
 * - Every member is a real child Agent (`ctx.agents.create`) with a role-scoped
 *   tool allow list. A read-only role is additionally given the read-only
 *   sandbox and the never-approval policy, so the restriction is not only a list
 *   of names.
 * - A writer branches into its own worktree before it starts, and the workspace
 *   is only changed by an explicit `engineering_team_merge` call.
 * - Membership is durable — the board records an owner by member id — while
 *   everything else about a member is read from the live child Agent rather
 *   than mirrored here, because a mirror of another process's state can only be
 *   wrong.
 *
 * All of these names match the deferred-tool prefix rule, so they cost nothing
 * on a request that never uses them and are revealed by `tool_search`.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/team/tools
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { HARNESS_TEAM_OWNED_TOOLS, PLUGIN_TEAM_ENHANCEMENT_TOOLS, findUpstreamTeams, type UpstreamTeams } from './authority.ts'
import { TeamBoard, type TeamTask } from './board.ts'
import { TeamContextControl } from './context.ts'
import { TeamMembers, type TeamMember } from './members.ts'
import {
  BUILT_IN_TEAM_ROLES,
  loadProjectTeamRoles,
  mergeTeamRoles,
  resolveRoleTools,
  roleInstructions,
  teamRoleById,
  type TeamRoleDefinition,
} from './roles.ts'
import { LOCKED_ISOLATION_FIELDS, TeamWorktrees, worktreeIsolation, type TeamWorktree } from './worktree.ts'
import { TEAM_NOTE_LIMIT, boundedTeamText, teamDirectory, teamRootDirectory } from './state.ts'
import { buildIsolationReport, describeIsolation } from '../isolation-report.ts'
import type { TeamRuntimeStatus } from '../types.ts'
import { toolDefinition as rawTool, type ToolDefinitionShape } from '../tool-definition.ts'

/**
 * A tool name that can write to the workspace or run a command.
 *
 * Used to answer one question about a started member: does its resolved tool
 * allow list still contain a way to change the tree? That is enforcement this
 * plugin owns, so it is reported as evidence rather than as intent.
 */
const WRITE_OR_SHELL_TOOL = /write|edit|patch|apply|bash|shell|exec|command|run|spawn|create/i

/**
 * Tasks one `engineering_team_board` read returns.
 *
 * The board accumulates — `engineering_team_plan` says so and caps a single call
 * at forty — so a long-lived team outgrows one answer, and the read is a window.
 * It is the *first* ids, which is the order tasks are claimed in, so the work a
 * reader can act on is the work it sees.
 *
 * What the window must not do is pass for the board, and the count it was cut
 * from is what says so. `summary.total` cannot answer that question: it counts
 * every task on the board, while this window is cut from the ones the
 * `include_done` filter left, so with `include_done: false` the two disagree by
 * exactly the done tasks. Both numbers travel with the list, the way
 * `engineering_hunks` reports `total` beside `shown`.
 */
const TEAM_BOARD_TASK_LIMIT = 60

/** Minimal view of the settings source this module reads. */
interface SettingsSource { get(): unknown }

/** Defaults the Host resolved for a fresh child Agent. */
export interface TeamMemberDefaults {
  readonly engine: 'deepseek' | 'codex' | 'claude'
  readonly provider: string
  readonly model?: string
}

export interface TeamToolsDeps {
  readonly ctx: Context
  readonly settings: SettingsSource | undefined
  readonly defaultAgentOptions: () => TeamMemberDefaults
  /**
   * How far the sandbox deny list reaches, for the member's isolation report.
   *
   * Injected rather than read here because the patterns are settings, and the
   * point of attaching them is that a caller reads the member's restriction and
   * the deny list's reach together — the effective limit is the weaker of the two.
   */
  readonly denyEnforcement?: (() => { readonly enforcedBy: 'tool-scope' | 'none'; readonly fallbackReason?: string }) | undefined
}

/** Structural view of the tool registry, matching the other tool clusters. */
interface ToolServiceLike {
  register(tool: ToolDefinitionShape): (() => void) | { dispose?: () => void }
  schemas(scope?: unknown): readonly { readonly name: string }[]
}

interface AgentLike {
  readonly id: string
  readonly session: {
    readonly header: { readonly cwd?: string | undefined; readonly parentSession?: string | undefined }
    snapshotEvents(): readonly { readonly seq: number; readonly type: string; readonly data?: unknown }[]
  }
  followup(message: unknown): void
  whenIdle(): Promise<void>
  /** Only a *parent* agent needs this: it is what creates the members. */
  readonly ctx?: {
    readonly agents: { create(spec: unknown): Promise<unknown> }
  }
}
interface AgentHandleLike { readonly agent: unknown; dispose(): Promise<void> }

const output = {
  schema: { type: 'object' as const, additionalProperties: true },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
}

/** Everything one team's state holds for one parent session. */
interface TeamState {
  readonly id: string
  readonly directory: string
  readonly board: TeamBoard
  readonly members: TeamMembers
  readonly worktrees: TeamWorktrees
  readonly context: TeamContextControl
  /** Live child Agents, so a member can be stopped and disposed. */
  readonly handles: Map<string, { readonly handle: AgentHandleLike; readonly agent: AgentLike }>
}

// The status shape lives in `types.ts` because it crosses the Remote boundary,
// and the typert generator requires boundary types on a public non-root subpath.
export type { TeamRuntimeStatus } from '../types.ts'

export class FreeCodeGoTeamRuntime {
  private readonly tools: ToolServiceLike | undefined
  private readonly teams = new Map<string, TeamState>()
  private readonly disposals: (() => void)[] = []
  /**
   * The Harness's team service, when this composition mounted one.
   *
   * Resolved once, in the constructor, because whether the plugin's parallel
   * tools exist has to be settled before the first request is assembled: a tool
   * that appears or disappears between requests changes the catalog the model is
   * shown. Our bundle therefore loads the Harness's team runtime *before* this
   * plugin (see `cordis.patch.yml`), which is what makes the answer stable
   * rather than order-dependent.
   */
  private readonly upstreamTeams: UpstreamTeams | undefined
  private disposed = false

  constructor(private readonly deps: TeamToolsDeps) {
    this.tools = (deps.ctx as unknown as { get(name: string): unknown }).get('tools') as ToolServiceLike | undefined
    this.upstreamTeams = findUpstreamTeams(deps.ctx)
  }

  start(): void {
    if (this.tools?.register === undefined) return
    // A child Agent that disposes for any reason — stop, crash, engine failure —
    // must not leave a member recorded as still working, or the next reader
    // would wait on a member that no longer exists.
    this.deps.ctx.on('agent/disposed', ({ agent }) => { this.observeDisposed(agent) })
    try { this.registerTools() } catch (error) {
      // A tool-registration failure must not take the plugin down: the team
      // surface simply stays unavailable, and everything else still loads.
      this.dispose()
      throw error
    }
  }

  dispose(): void {
    this.disposed = true
    for (const dispose of this.disposals.splice(0)) { try { dispose() } catch { /* registry already gone */ } }
  }

  status(): TeamRuntimeStatus {
    let members = 0
    for (const team of this.teams.values()) members += team.handles.size
    return {
      enabled: this.enabled(),
      // The readout lists the built-in library, not a project's overrides:
      // overrides are per workspace, and this status is read before one is open.
      roles: BUILT_IN_TEAM_ROLES.map(role => ({
        id: role.id,
        title: role.title,
        purpose: role.purpose,
        notResponsibleFor: role.notResponsibleFor,
        capabilities: role.capabilities,
        sandbox: role.sandbox,
        maxTurns: role.maxTurns,
      })),
      teams: this.teams.size,
      members,
      contextControl: new TeamContextControl(this.deps.ctx).available().ok,
      authority: this.upstreamTeams === undefined ? 'plugin' : 'harness',
      // Reported as data rather than left to the reader to infer from the tool
      // list: "the Harness owns the team" is the settlement of a duplication, and
      // a status surface that can show it is how a reviewer checks it without
      // reading this file.
      supersededTools: this.upstreamTeams === undefined ? [] : [...HARNESS_TEAM_OWNED_TOOLS],
      // The other half of the same settlement, and the reason it is emitted from
      // the list the registration path reads rather than hard-coded here: a
      // capability this plugin still owns would otherwise disappear from the
      // report the moment someone edited the list, which is the failure a
      // hand-written readout always has.
      enhancementTools: [...PLUGIN_TEAM_ENHANCEMENT_TOOLS],
    }
  }

  private enabled(): boolean {
    if (this.disposed) return false
    const value = this.deps.settings?.get() as { readonly engineeringEnabled?: unknown; readonly engineeringTeamEnabled?: unknown } | undefined
    return value?.engineeringEnabled === true && value.engineeringTeamEnabled !== false
  }

  /** One team per root session, kept in its own directory so a restart finds it. */
  private async teamFor(agent: AgentLike): Promise<TeamState> {
    if (!this.enabled()) throw new Error('team features are disabled in the FreeCodeGo engineering settings')
    const id = (agent.session.header.parentSession ?? agent.id).replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 48) || 'team'
    const existing = this.teams.get(id)
    if (existing !== undefined) return existing
    const directory = teamDirectory(teamRootDirectory(), id)
    const team: TeamState = {
      id,
      directory,
      board: new TeamBoard(id, join(directory, 'board.json')),
      members: new TeamMembers(id, join(directory, 'members.json')),
      worktrees: new TeamWorktrees((agent.session.header.cwd ?? process.cwd()), join(directory, 'worktrees.json')),
      context: new TeamContextControl(this.deps.ctx),
      handles: new Map(),
    }
    this.teams.set(id, team)
    return team
  }

  private observeDisposed(agent: AgentLike): void {
    if (this.disposed) return
    const id = agent.id
    for (const team of this.teams.values()) {
      const memberId = [...team.handles.entries()].find(([, entry]) => entry.agent.id === id)?.[0]
      if (memberId === undefined) continue
      team.handles.delete(memberId)
      void team.members.markStopped(memberId, 'stopped').catch(() => undefined)
    }
  }

  private async rolesFor(cwd: string): Promise<readonly TeamRoleDefinition[]> {
    return mergeTeamRoles(await loadProjectTeamRoles(cwd))
  }

  private registerTools(): void {
    const tools = this.tools
    if (tools === undefined) return
    // Registration returns a disposer on this Harness version but a handle on
    // others, so both shapes are normalized to one function before it is kept.
    const register = (tool: ToolDefinitionShape, label: string): void => {
      // The Harness's team runtime supersedes a named set of these. Skipped here
      // rather than never written: the same tools are the fallback for a
      // composition that mounted no team runtime, and there is only one
      // authority either way (see team/authority.ts).
      const name: string = tool.name
      if (this.upstreamTeams !== undefined && HARNESS_TEAM_OWNED_TOOLS.includes(name)) {
        this.deps.ctx.logger?.debug?.(`freecodego: ${name} is not registered because the Harness team runtime owns the team`)
        return
      }
      const registered = tools.register(tool)
      const cleanup: () => void = typeof registered === 'function' ? registered : () => { registered.dispose?.() }
      this.disposals.push(cleanup)
      this.deps.ctx.effect(() => () => { cleanup() }, label)
    }

    register(rawTool({
      name: 'engineering_team_board',
      description: 'Read the team task board: the tasks with their owner and status, which tasks are blocked and by what, per-member claim counts, and the members with the role and task each holds. The task list is a window onto the board, not the board: `tasksShown` of the `tasksMatching` that passed the filter, taken in id order, which is the order they are claimed in. Compare the two before reporting the board as complete. Call this before claiming work or reporting progress.',
      parameters: { type: 'object', additionalProperties: false, properties: { include_done: { type: 'boolean', description: 'Include completed tasks. Defaults to true.' } } },
      output,
      execute: async (args: { readonly include_done?: boolean }, exec: { readonly agent?: Agent }) => {
        const team = await this.teamFor(requireAgent(exec))
        const matching = (await team.board.list()).filter(task => args.include_done !== false || task.status !== 'done')
        return {
          team: team.id,
          summary: await team.board.summary(),
          // The window and the count it was cut from, so a partial list cannot be
          // reported as the whole board. See `TEAM_BOARD_TASK_LIMIT`.
          tasksMatching: matching.length,
          tasksShown: Math.min(matching.length, TEAM_BOARD_TASK_LIMIT),
          tasks: matching.slice(0, TEAM_BOARD_TASK_LIMIT),
          blocked: await team.board.blocked(),
          members: await team.members.list(),
        }
      },
      presentCall: () => ({ card: 'generic', title: 'Read team board' }),
    }), 'freecodego: team board tool')

    register(rawTool({
      name: 'engineering_team_plan',
      description: 'Create the team task board for this objective. Tasks are claimed in id order, so write them in the order they should be done. Use depends_on to gate a task on earlier ones, either by id or by the position it has in this call ("$1" for the first task). Creating a plan replaces nothing: tasks already on the board stay there.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['tasks'],
        properties: {
          tasks: {
            type: 'array', minItems: 1, maxItems: 40,
            items: {
              type: 'object', additionalProperties: false, required: ['title'],
              properties: {
                title: { type: 'string', minLength: 1, maxLength: 300 },
                detail: { type: 'string', maxLength: 4000 },
                depends_on: { type: 'array', items: { type: 'string' }, maxItems: 10 },
              },
            },
          },
        },
      },
      output,
      execute: async (args: { readonly tasks: readonly { readonly title: string; readonly detail?: string; readonly depends_on?: readonly string[] }[] }, exec: { readonly agent?: Agent }) => {
        const agent = requireAgent(exec) as unknown as AgentLike
        const team = await this.teamFor(agent)
        const created = await team.board.create({
          createdBy: agent.session.header.parentSession === undefined ? 'parent' : 'member',
          tasks: args.tasks.map(task => ({ title: task.title, ...(task.detail === undefined ? {} : { detail: task.detail }), ...(task.depends_on === undefined ? {} : { dependsOn: task.depends_on }) })),
        })
        return { team: team.id, created, summary: await team.board.summary() }
      },
      presentCall: (args: { readonly tasks?: readonly unknown[] }) => ({ card: 'generic', title: `Plan team tasks: ${String(args.tasks?.length ?? 0)}` }),
    }), 'freecodego: team plan tool')

    register(rawTool({
      name: 'engineering_team_claim',
      description: 'Claim the next available task on the board for a member, or a specific task by id. Availability is id order, and a task whose dependencies are not done is refused with the ids it is waiting on, as is a task another member already owns. Claiming does not start any work: it records who is accountable for the task. The claim returns a claim_token; closing or failing that task requires presenting it, which is what stops a restarted member from closing work it no longer holds.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['member'],
        properties: {
          member: { type: 'string', description: 'Member id or label, as shown by engineering_team_board.' },
          task_id: { type: 'string', description: 'Claim this exact task instead of the next one.' },
          task_version: { type: 'integer', minimum: 0, description: 'The task revision you last read. Supply it to make the claim a compare-and-set: if the task moved since you read it, the claim is refused instead of racing another member.' },
        },
      },
      output,
      execute: async (args: { readonly member: string; readonly task_id?: string; readonly task_version?: number }, exec: { readonly agent?: Agent }) => {
        const team = await this.teamFor(requireAgent(exec))
        const member = await requireMember(team, args.member)
        const target = args.task_id ?? (await team.board.nextFor(member.id))?.id
        if (target === undefined) return { claimed: undefined, detail: 'no task on this board is available to claim right now' }
        const task = await team.board.claim(target, member.id, args.task_version === undefined ? {} : { expectedVersion: args.task_version })
        await team.members.update(member.id, { state: 'working', taskId: task.id })
        return { claimed: task, claim_token: task.claimToken, next: (await team.board.nextFor(member.id))?.id }
      },
      presentCall: (args: { readonly member?: string }) => ({ card: 'generic', title: `Claim task for ${(args.member ?? 'member')}` }),
    }), 'freecodego: team claim tool')

    register(rawTool({
      name: 'engineering_team_task_update',
      description: 'Close out a claimed task, cancel one that will not be done, record a review decision on it, park it on a human, or reopen a failure. Only the member that owns a task may complete, fail, release, request_review or resume it; the owner fence is what makes the board an audit of who did what rather than a wish list. cancel is the one action without that fence, because the caller that cancels is usually the parent and the task may have outlived the member that held it. A task claimed with a token can only be closed by presenting that token, so a restarted member cannot close work it no longer holds. Completing a task unblocks its dependents. Use approve or reject to record a review verdict without changing the task status. Use request_review when the work cannot continue until a person decides something: it is neither a failure nor progress, the board reports it separately with who it waits on, it leaves the claim with its owner, and it does not block dependents — resume puts that same task back to work once the answer arrives, and rerun reopens a failed or cancelled task for another attempt under the same id.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['member', 'task_id', 'action'],
        properties: {
          member: { type: 'string' },
          task_id: { type: 'string' },
          action: { type: 'string', enum: ['complete', 'fail', 'release', 'approve', 'reject', 'request_review', 'resume', 'rerun', 'cancel'] },
          claim_token: { type: 'string', description: 'The token returned by engineering_team_claim for this task. Required to complete or fail a task that was claimed with one.' },
          waiting_on: { type: 'string', maxLength: 120, description: 'For request_review: who is being waited on, e.g. "the user" or a member label. Shown on the board for as long as the task is parked.' },
          note: { type: 'string', maxLength: TEAM_NOTE_LIMIT },
          artifacts: { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: 20, description: 'Files or commands a reviewer should look at.' },
        },
      },
      output,
      execute: async (args: { readonly member: string; readonly task_id: string; readonly action: 'complete' | 'fail' | 'release' | 'approve' | 'reject' | 'request_review' | 'resume' | 'rerun' | 'cancel'; readonly claim_token?: string; readonly note?: string; readonly waiting_on?: string; readonly artifacts?: readonly string[] }, exec: { readonly agent?: Agent }) => {
        const team = await this.teamFor(requireAgent(exec))
        const member = await requireMember(team, args.member)
        // Read before the write: rerun clears the owner, and the roster row of the
        // member that used to hold the task has to stop naming it, or the board
        // contradicts itself about who owns what.
        const before = args.action === 'rerun' || args.action === 'cancel' ? await team.board.get(args.task_id) : undefined
        const task = args.action === 'approve' || args.action === 'reject'
          // A verdict never moves the task; the owner still closes it, which is
          // what keeps "reviewed" and "done" from collapsing into one word.
          ? await team.board.approve(args.task_id, member.id, args.action === 'approve' ? 'approved' : 'rejected', args.note ?? '')
          : args.action === 'release'
            ? await team.board.release(args.task_id, member.id, args.claim_token)
            : args.action === 'request_review'
              // A parked task without a reason is the failure this state exists to
              // remove: the board would say "waiting" and nobody would know for
              // what, so the note is required here rather than defaulted.
              ? await team.board.requestReview(args.task_id, member.id, {
                note: requireReviewNote(args.note),
                ...(args.waiting_on === undefined ? {} : { waitingOn: args.waiting_on }),
                ...(args.claim_token === undefined ? {} : { claimToken: args.claim_token }),
              })
              : args.action === 'resume'
                ? await team.board.resume(args.task_id, member.id, {
                  ...(args.claim_token === undefined ? {} : { claimToken: args.claim_token }),
                  ...(args.note === undefined ? {} : { note: args.note }),
                })
                : args.action === 'rerun'
                  ? await team.board.rerun(args.task_id, member.id, args.note ?? '')
                  : args.action === 'cancel'
                    ? await team.board.cancel(args.task_id, args.note)
                    : await team.board.transition(args.task_id, member.id, {
                    status: args.action === 'complete' ? 'done' : 'failed',
                    ...(args.claim_token === undefined ? {} : { claimToken: args.claim_token }),
                    ...(args.note === undefined ? {} : { note: args.note }),
                    ...(args.artifacts === undefined ? {} : { artifacts: args.artifacts }),
                  })
        if (args.action === 'complete' || args.action === 'fail' || args.action === 'release') {
          // Completing and releasing both end the member's hold, so the recorded
          // task goes with them: this roster is what the board reports as "the
          // task each member holds", and keeping a finished or handed-back task
          // there names work the member no longer owns.
          await team.members.update(member.id, args.action === 'fail'
            ? { state: 'working', taskId: args.task_id }
            : { state: 'idle', clearTask: true })
        } else if (args.action === 'request_review') {
          // Still accountable for the task, not working on it.
          await team.members.update(member.id, { state: 'waiting', taskId: args.task_id })
        } else if (args.action === 'resume') {
          await team.members.update(member.id, { state: 'working', taskId: args.task_id })
        } else if (args.action === 'rerun' && before?.owner !== undefined) {
          // The reopened task belongs to nobody now — the board cleared its owner —
          // and the member that failed it should not still be reported as holding
          // it, whoever did the rerunning.
          await team.members.update(before.owner, { state: 'idle', clearTask: true })
        } else if (args.action === 'cancel' && before?.owner !== undefined) {
          // A cancelled task is closed, so the roster stops naming it — the same
          // reason the hand-back paths above clear theirs. `cancel` carries no owner
          // fence, so the row that has to change is the record of whoever held the
          // task, which need not be this caller.
          await team.members.update(before.owner, { state: 'idle', clearTask: true })
        }
        return { task, summary: await team.board.summary(), blocked: await team.board.blocked() }
      },
      presentCall: (args: { readonly task_id?: string; readonly action?: string }) => ({ card: 'generic', title: `${(args.action ?? 'update')} ${(args.task_id ?? 'task')}` }),
    }), 'freecodego: team task update tool')

    register(rawTool({
      name: 'engineering_team_member_start',
      description: 'Start a team member as a real child Agent with a role from the role library. A read-only role gets the read-only sandbox and a tool scope with no write or shell tools; a writing role gets its own git worktree so two writers never share a directory. Its brief — the role contract, the task it was claimed, and any instructions here — is delivered as its first turn, so a started member is already working on something.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['role'],
        properties: {
          // No `enum`, deliberately. The role library is not the built-in five:
          // `mergeTeamRoles` adds an id from the project's
          // `.freecodego/team-roles.json` beside the built-ins (a same-id entry
          // only *replaces* one), and `rolesFor` resolves the merged library on
          // every call — so an enum listing the built-ins would make a role the
          // project defined, parsed and resolved unreachable through the one tool
          // that starts a member. The handler is the guard: it refuses an id no
          // role answers to and now names the ids it can resolve.
          role: { type: 'string', minLength: 1, description: 'Role id from the role library. The built-ins are explorer, architect, implementer, verifier and integrator; a project may add or replace roles in .freecodego/team-roles.json.' },
          label: { type: 'string', maxLength: 120 },
          engine: { type: 'string', enum: ['deepseek', 'codex', 'claude'] },
          task_id: { type: 'string', description: 'Claim this board task for the member before it starts.' },
          isolate: { type: 'boolean', description: 'Give a writing role its own worktree. Defaults to true.' },
          instructions: { type: 'string', maxLength: 4000, description: 'Initial brief. The role contract is appended to it.' },
        },
      },
      output,
      execute: async (args: { readonly role: string; readonly label?: string; readonly engine?: 'deepseek' | 'codex' | 'claude'; readonly task_id?: string; readonly isolate?: boolean; readonly instructions?: string }, exec: { readonly agent?: Agent; readonly signal: AbortSignal }) => {
        const parent = requireAgent(exec) as unknown as AgentLike
        const team = await this.teamFor(parent)
        const cwd = parent.session.header.cwd
        if (cwd === undefined || cwd.trim() === '') throw new Error('a team member needs a workspace-backed parent session')
        const roles = await this.rolesFor(cwd)
        const role = teamRoleById(roles, args.role)
        // Names what this workspace *does* resolve: the ids are project-dependent
        // (the schema cannot enumerate them), so a refusal that only says
        // "unknown" leaves the caller with no way to find a name that works.
        if (role === undefined) throw new Error(`unknown team role "${args.role}"; this workspace resolves ${roles.map(candidate => candidate.id).join(', ')}`)
        const wantsWrite = role.sandbox === 'workspace-write'
        const isolation = wantsWrite && args.isolate !== false ? await team.worktrees.available() : { ok: false as const, reason: 'this role does not write' }
        const defaults = this.deps.defaultAgentOptions()
        const member = await team.members.register({
          label: args.label ?? role.id,
          role: role.id,
          engine: args.engine ?? defaults.engine,
          ...(role.model === 'inherit' ? (defaults.model === undefined ? {} : { model: defaults.model }) : { model: role.model }),
        })
        // Captured from the setup that actually runs, so the isolation report is
        // evidence rather than a restatement of what was requested.
        let resolvedAllow: readonly string[] | undefined
        let policyApplied = false
        // The claim and the child Agent both belong to the rollback, not beside
        // it. Everything from here on has already written roster state, and every
        // way out of it must leave the team consistent: a claim the board refuses
        // (another member holds the task, it is blocked, it is closed) or a
        // composition without an agent service used to leave the member frozen at
        // `state: 'starting'` for the rest of the team's life — registered, never
        // started, and un-stoppable because there is no handle to stop.
        let task: TeamTask | undefined
        let handle: AgentHandleLike | undefined
        let worktree: TeamWorktree | undefined
        try {
          // The worktree's owner must be the same durable member id that every
          // later tool receives. A disposable allocation id made the start look
          // isolated but left `engineering_team_merge(member.id)` unable to find
          // the branch it was supposed to integrate.
          worktree = isolation.ok ? await team.worktrees.allocate(member.id) : undefined
          if (worktree !== undefined) await team.members.update(member.id, { worktree: worktree.path })
          const agents = parent.ctx?.agents
          if (agents === undefined) throw new Error('this composition has no agent service, so a team member cannot be started')
          const sessionId = SessionId(randomUUID())
          task = args.task_id === undefined ? undefined : await team.board.claim(args.task_id, member.id)
          handle = await agents.create({
            sessionId,
            meta: { cwd: worktree?.path ?? cwd, parentSession: parent.id, origin: 'subagent', delegationDepth: 1 },
            agentOptions: {
              provider: member.engine === 'codex' ? 'codex' : defaults.provider,
              ...(member.model === undefined ? {} : { model: member.model }),
              freeCodeGoEngine: args.engine ?? defaults.engine,
              freeCodeGoReadOnly: role.sandbox === 'read-only',
              maxTokens: 4_000 * role.maxTurns,
            } as never,
            signal: exec.signal,
            setup: (childCtx: ChildContextLike) => {
              const available = childCtx.tools.schemas(childCtx.agent).map(schema => schema.name)
              const allow = resolveRoleTools(role, available)
              // A read-only role that somehow resolved to nothing would be a
              // silent no-op restriction, so it fails the start instead.
              if (allow.length === 0) throw new Error(`role "${role.id}" has no usable tools in this composition`)
              childCtx.tools.restrict({ allow })
              resolvedAllow = allow
              if (role.sandbox === 'read-only') {
                setSandboxMode(childCtx.agent.session as never, 'read-only')
                setApprovalPolicy(childCtx.agent.session as never, 'never')
                policyApplied = true
              }
            },
          }) as unknown as AgentHandleLike
          const memberAgent = handle.agent as unknown as AgentLike
          team.handles.set(member.id, { handle, agent: memberAgent })
          const brief = `${roleInstructions(role, {
            ...(task === undefined ? {} : { task: { id: task.id, title: task.title, detail: task.detail, claimToken: task.claimToken } }),
            teammates: (await team.members.list()).map(entry => entry.label),
          })}${args.instructions === undefined ? '' : `\n\nAdditional instructions from the parent:\n${boundedTeamText(args.instructions)}`}`
          memberAgent.followup(createUserMessage({ source: { kind: 'plugin', plugin: 'freecodego-team' }, content: [{ type: 'text', text: brief }] }))
          // The roster is told the member is working only after its brief is on
          // its way. Broadcasting it earlier marked a member 'working' on a task
          // whose brief never arrived, and the rollback below would then leave
          // that task id recorded on a member the board had already released it
          // from — the same false "holds this task" the hand-back path fixes.
          await team.members.update(member.id, { state: 'working', ...(task === undefined ? {} : { taskId: task.id }) })
          const deny = this.deps.denyEnforcement?.()
          const isolationReport = buildIsolationReport({
            requested: role.sandbox === 'read-only' ? 'read-only' : 'workspace-write',
            policyApplied,
            // Tool scope is the enforcement this plugin owns, and it is checkable:
            // the allow list either still contains write or shell tools or it does not.
            toolScopeApplied: resolvedAllow !== undefined && !resolvedAllow.some(name => WRITE_OR_SHELL_TOOL.test(name)),
            ...(worktree === undefined ? {} : { worktree: worktree.path }),
            ...(deny === undefined ? {} : { denyEnforcement: deny }),
          })
          return { member: { ...member, ...(worktree === undefined ? {} : { worktree: worktree.path }), taskId: task?.id }, task, worktree, isolation: isolationReport, isolationSummary: describeIsolation(isolationReport), roles: roles.map(entry => ({ id: entry.id, title: entry.title, capabilities: entry.capabilities })) }
        } catch (error) {
          // The start failed, so there is no isolation to report — and that is
          // exactly why the throw is the answer rather than a report with
          // `restricted: false`. A member whose setup threw must never be
          // reported as restricted on the strength of the intent it was started
          // with, and the strongest way to say that is to answer with nothing at
          // all. The roster records *that* it failed and why, which is the fact a
          // later reader needs; what it was never confined by is not a claim
          // worth publishing.
          //
          // A child Agent that was already created is disposed before the roster
          // says the member failed. Without this the Agent keeps running and
          // spending turns on a brief nobody is waiting for, and the team holds
          // two answers to "is this member alive" — the roster's `failed` and the
          // live handle. The handle is dropped first so the disposal event cannot
          // overwrite the failure with a plain `stopped`.
          if (handle !== undefined) {
            team.handles.delete(member.id)
            await handle.dispose().catch(() => undefined)
          }
          // The other half of that rollback: a member that never reached a child
          // Agent has nothing in its worktree and no Agent that could have put
          // anything there, so its isolation is handed back with its claim.
          // Keeping it would leave the recovery report naming unmerged work for a
          // member that never ran, with no tool left that could ever release it.
          // Past the child Agent the worktree is kept on purpose — disposal races
          // whatever the child wrote on its way out, and a release is not the step
          // that is allowed to destroy work.
          if (handle === undefined && worktree !== undefined) await team.worktrees.release(worktree.id).catch(() => undefined)
          await team.members.markStopped(member.id, 'failed', error instanceof Error ? error.message : String(error))
          if (task !== undefined) await team.board.release(task.id, member.id).catch(() => undefined)
          throw error
        }
      },
      presentCall: (args: { readonly role?: string }) => ({ card: 'generic', title: `Start team member: ${(args.role ?? 'member')}` }),
    }), 'freecodego: team member start tool')

    register(rawTool({
      name: 'engineering_team_member_stop',
      description: 'Stop a team member and dispose its child Agent. Its worktree is kept, and its branch survives, so unfinished work can be reviewed or resumed; use engineering_team_merge to integrate a branch that is verified.',
      parameters: { type: 'object', additionalProperties: false, required: ['member'], properties: { member: { type: 'string' }, reason: { type: 'string', maxLength: 500 } } },
      output,
      execute: async (args: { readonly member: string; readonly reason?: string }, exec: { readonly agent?: Agent }) => {
        const team = await this.teamFor(requireAgent(exec))
        const member = await requireMember(team, args.member)
        const live = team.handles.get(member.id)
        if (live !== undefined) {
          team.handles.delete(member.id)
          await live.handle.dispose().catch(() => undefined)
        }
        await team.members.markStopped(member.id, 'stopped', args.reason)
        const released = member.taskId === undefined ? undefined : await team.board.release(member.taskId, member.id).catch(() => undefined)
        // Stopping hands the task back, so the roster must stop naming it — the same
        // reason the three task-update paths above clear it. This was the fourth
        // hand-back and the one left out, so `recover` reported a member holding a
        // task the board had already returned to the pool. Only a release that
        // happened clears it: a refused release leaves the task closed with the board
        // still naming this member as its owner, and then the roster has to agree.
        if (released !== undefined) await team.members.update(member.id, { clearTask: true })
        return { member: await team.members.member(member.id), released }
      },
      presentCall: (args: { readonly member?: string }) => ({ card: 'generic', title: `Stop member ${(args.member ?? '')}` }),
    }), 'freecodego: team member stop tool')

    register(rawTool({
      name: 'engineering_team_merge',
      description: 'Merge one member\'s worktree branch into the workspace. This is the only team operation that changes the shared tree. A conflicting merge is aborted before it is reported, so the workspace is never left half-merged, and the result names the conflicting files plus the worktree they must be resolved in. Merge verified work only, and merge in dependency order.',
      parameters: { type: 'object', additionalProperties: false, required: ['member'], properties: { member: { type: 'string' }, message: { type: 'string', maxLength: 200 } } },
      output,
      execute: async (args: { readonly member: string; readonly message?: string }, exec: { readonly agent?: Agent }) => {
        const team = await this.teamFor(requireAgent(exec))
        const member = await requireMember(team, args.member)
        const outcome = await team.worktrees.integrate(member.id, args.message === undefined ? {} : { message: args.message })
        // The conflict is reported, not routed: a member is only reachable while
        // its child Agent is live, so the caller decides whether to resolve it,
        // hand it to a fresh member, or abandon the branch.
        return {
          ...outcome,
          member: member.label,
          ...(outcome.conflicts.length === 0 ? {} : { resolveIn: outcome.worktree.path }),
        }
      },
      presentCall: (args: { readonly member?: string }) => ({ card: 'generic', title: `Merge ${(args.member ?? 'member')}` }),
    }), 'freecodego: team merge tool')

    register(rawTool({
      name: 'engineering_team_recover',
      description: 'Report what a restart or a dead member left in flight, and what to do about it. The board, the member records, and the worktree registry are durable, so this is derived from stored state rather than from memory: it names every task still claimed or parked on a review (with who it waits on), which of those claims no longer has a live member behind it, and which worktrees hold unmerged work. Each live worktree carries its durable isolation fields — its path, branch, mode, repository and state — read from the record rather than reconstructed from the directory name.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output,
      execute: async (_args: unknown, exec: { readonly agent?: Agent }) => {
        const team = await this.teamFor(requireAgent(exec))
        const tasks = await team.board.list()
        const members = await team.members.list()
        const inFlight = tasks
          // A parked task is in flight in the sense that matters here: it is held,
          // it is not progressing, and after a restart somebody has to be told what
          // it is waiting for — which is exactly the question this report answers.
          .filter(task => task.status === 'claimed' || task.status === 'needs-review')
          .map(task => ({
            task: { id: task.id, title: task.title, owner: task.owner, status: task.status },
            // A claim whose owner has no live child Agent is the concrete thing
            // a restart orphans, and the reason this report exists.
            liveMember: task.owner !== undefined && team.handles.has(task.owner),
            worktree: members.find(entry => entry.id === task.owner)?.worktree,
            ...(task.status === 'needs-review'
              ? { waitingOn: task.waitingOn ?? 'a human reviewer', waitingSince: task.waitingSince ?? task.updatedAt }
              : {}),
          }))
        const isolationFields = LOCKED_ISOLATION_FIELDS
        return {
          inFlight,
          members,
          board: await team.board.summary(),
          blocked: await team.board.blocked(),
          // Each row carries the locked field set, and it is selected from that
          // list rather than written out here, so a reader of the report and a
          // reader of the record cannot disagree about which facts exist. The
          // fields name the copy's path, branch and state instead of leaving them
          // to be inferred from a directory name. See `team/worktree.ts`.
          worktrees: (await team.worktrees.list())
            .filter(entry => entry.state === 'active')
            .map(entry => ({
              id: entry.id,
              memberId: entry.memberId,
              isolation: worktreeIsolation(entry, { teamStateRoot: team.worktrees.stateRoot, repoRoot: team.worktrees.repoRoot }),
              isolationFields,
            })),
          note: 'a claimed task with liveMember false has no running child Agent: release it for another member, or start a member again and re-claim it. A task with status needs-review is waiting on a person, not on a member: it is resumed by its owner once that answer arrives.',
        }
      },
      presentCall: () => ({ card: 'generic', title: 'Recover team state' }),
    }), 'freecodego: team recover tool')

    register(rawTool({
      name: 'engineering_context_compact',
      description: 'Summarize useful history now, without waiting for the context-pressure threshold. Call it after finishing a phase whose details no longer matter: the replaced span is summarized in place and stays recoverable from the session log. It returns changed:false when the engine found nothing safe to replace, which is an answer, not a failure.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output,
      execute: async (_args: unknown, exec: { readonly agent?: Agent; readonly signal: AbortSignal }) => {
        const team = await this.teamFor(requireAgent(exec))
        return await team.context.compactNow(requireAgent(exec), exec.signal)
      },
      presentCall: () => ({ card: 'generic', title: 'Compact context now' }),
    }), 'freecodego: context compact tool')

    register(rawTool({
      name: 'engineering_context_snip',
      description: 'Replace an old span of this conversation with one summary node, keeping the most recent turns. Use it to drop a region you have already extracted what you need from. The engine validates that the span keeps tool calls paired with their results and will refuse rather than over-delete, so an unbalanced boundary is an error, not a silently larger cut.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          keep_recent_turns: { type: 'integer', minimum: 1, maximum: 20, description: 'How many recent assistant turns to keep. Defaults to 1.' },
          start: { type: 'integer', description: 'First surface seq to replace, when you know it.' },
          end: { type: 'integer', description: 'Last surface seq to replace, when you know it.' },
        },
      },
      output,
      execute: async (args: { readonly keep_recent_turns?: number; readonly start?: number; readonly end?: number }, exec: { readonly agent?: Agent; readonly signal: AbortSignal }) => {
        const team = await this.teamFor(requireAgent(exec))
        return await team.context.snip(
          requireAgent(exec),
          { ...(args.keep_recent_turns === undefined ? {} : { keepRecentTurns: args.keep_recent_turns }), ...(args.start === undefined ? {} : { start: args.start }), ...(args.end === undefined ? {} : { end: args.end }) },
          exec.signal,
        )
      },
      presentCall: (args: { readonly keep_recent_turns?: number }) => ({ card: 'generic', title: `Snip context (keep ${String(args.keep_recent_turns ?? 1)})` }),
    }), 'freecodego: context snip tool')
  }
}

function requireAgent(exec: { readonly agent?: Agent }): Agent {
  if (exec.agent === undefined) throw new Error('team tools require an active agent')
  return exec.agent
}

/** Structural view of the child context a member's `setup` receives. */
interface ChildContextLike {
  readonly agent: {
    readonly session: unknown
  }
  readonly tools: {
    schemas(scope?: unknown): readonly { readonly name: string }[]
    restrict(filter: { readonly allow?: readonly string[]; readonly deny?: readonly string[] }): unknown
  }
}

async function requireMember(team: TeamState, idOrLabel: string): Promise<TeamMember> {
  const member = await team.members.member(idOrLabel)
  if (member === undefined) throw new Error(`no team member matches "${idOrLabel}"`)
  return member
}

/**
 * The reason a task is parked, without which parking it is not an improvement.
 *
 * Required rather than defaulted because an unexplained `needs-review` recreates
 * exactly the problem the status exists to fix: the board says a person is needed
 * and nobody can tell what for.
 */
function requireReviewNote(note: string | undefined): string {
  if (note === undefined || note.trim() === '') throw new Error('request_review needs a note saying what the answer has to settle')
  return note
}
