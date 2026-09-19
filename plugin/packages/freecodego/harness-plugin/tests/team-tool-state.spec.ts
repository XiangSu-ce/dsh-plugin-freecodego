/**
 * What the team tools leave recorded — after a failure, and after a hand-back.
 *
 * A member start writes three things before it can succeed — a roster entry, a
 * board claim, and a child Agent — and it can fail between any two of them. The
 * property under test is that every such failure ends in one consistent state:
 * a member recorded as failed with the reason, no claim held by a member that
 * never ran, and no live child Agent behind a member the roster calls stopped.
 * The defect these pin: the claim sat *outside* the rollback, so a refused claim
 * left the member frozen at `state: 'starting'` for the rest of the team's life,
 * and a failure after `agents.create` left the child running forever.
 *
 * The second property is the mirror image on the way out: a member that
 * completes or releases a task must stop being reported as holding it, because
 * this roster is what the board answers "the task each member holds" from.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FreeCodeGoTeamRuntime } from '../src/team/tools.ts'
import { TeamBoard } from '../src/team/board.ts'
import { TeamMembers, type TeamMember } from '../src/team/members.ts'
import { TEAM_NOTE_LIMIT, teamDirectory, teamRootDirectory } from '../src/team/state.ts'
import { LOCKED_ISOLATION_FIELDS, TeamWorktrees } from '../src/team/worktree.ts'

const run = promisify(execFile)

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await run('git', ['-C', cwd, ...args], { windowsHide: true })
  return result.stdout
}

const directories: string[] = []
const originalHome = process.env.FREECODEGO_HOME
let workspace = ''

beforeEach(async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'freecodego-team-start-'))
  directories.push(sandbox)
  workspace = join(sandbox, 'workspace')
  await rm(workspace, { recursive: true, force: true })
  await import('node:fs/promises').then(fs => fs.mkdir(workspace, { recursive: true }))
  // Team state resolves `$FREECODEGO_HOME` per call, so redirecting it here
  // keeps every assertion on this test's own files.
  process.env.FREECODEGO_HOME = join(sandbox, 'home')
})

afterEach(async () => {
  if (originalHome === undefined) delete process.env.FREECODEGO_HOME
  else process.env.FREECODEGO_HOME = originalHome
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

interface ToolLike {
  readonly name: string
  /** Present on what the runtime registers; read by the schema-agreement case below. */
  readonly parameters?: unknown
  execute(args: unknown, exec: unknown): Promise<unknown>
}

interface ChildDouble { disposed: number }

/** A ctx double covering what the team runtime reads, capturing its tools. */
function hostDouble(tools: ToolLike[]): unknown {
  return {
    logger: { debug: () => undefined },
    on: () => undefined,
    effect: (factory: () => (() => void) | undefined) => factory(),
    get: (name: string) => {
      if (name !== 'tools') return undefined
      return {
        register: (tool: unknown) => { tools.push(tool as ToolLike); return () => undefined },
        schemas: () => [],
      }
    },
  }
}

const TEAM_ID = 'parent-session'

/** Fresh stores per read: the durable file is the thing under test. */
async function roster(): Promise<readonly TeamMember[]> {
  return new TeamMembers(TEAM_ID, join(teamDirectory(teamRootDirectory(), TEAM_ID), 'members.json')).list()
}

async function taskRow(id: string) {
  return new TeamBoard(TEAM_ID, join(teamDirectory(teamRootDirectory(), TEAM_ID), 'board.json')).get(id)
}

function harness(options: { readonly followupThrows?: boolean; readonly noAgentService?: boolean } = {}) {
  const tools: ToolLike[] = []
  const created: ChildDouble[] = []
  const runtime = new FreeCodeGoTeamRuntime({
    ctx: hostDouble(tools) as never,
    settings: { get: () => ({ engineeringEnabled: true, engineeringTeamEnabled: true }) },
    defaultAgentOptions: () => ({ engine: 'deepseek', provider: 'freecodego' }),
  })
  runtime.start()
  const session = { header: { cwd: workspace, parentSession: TEAM_ID }, snapshotEvents: () => [] }
  const child: ChildDouble & { agent: unknown; dispose: () => Promise<void> } = {
    disposed: 0,
    agent: {
      id: 'child-agent',
      session,
      followup: () => {
        if (options.followupThrows === true) throw new Error('engine refused the brief')
      },
      whenIdle: async () => undefined,
    },
    dispose: async () => { child.disposed += 1 },
  }
  const parent = {
    id: 'parent-agent',
    session,
    followup: () => undefined,
    whenIdle: async () => undefined,
    ...(options.noAgentService === true ? {} : {
      ctx: {
        agents: {
          create: async (spec: { readonly setup?: (child: unknown) => void }) => {
            // The setup the child Agent's own composition runs: a read-only role
            // records its sandbox and approval policy on the child session.
            spec.setup?.({
              agent: { session: { append: async () => undefined, snapshotEvents: () => [] } },
              tools: { schemas: () => [{ name: 'read_file' }, { name: 'grep' }], restrict: () => undefined },
            })
            created.push(child)
            return child
          },
        },
      },
    }),
  }
  const exec = { agent: parent, signal: new AbortController().signal }
  const tool = (name: string): ToolLike => {
    const found = tools.find(candidate => candidate.name === name)
    if (found === undefined) throw new Error(`tool ${name} was not registered`)
    return found
  }
  return { runtime, tool, exec, created }
}

describe('team member start rollback', () => {
  it('ends a start its own claim refused in a terminal state, not in `starting`', async () => {
    const { runtime, tool, exec } = harness()
    await tool('engineering_team_plan').execute({ tasks: [{ title: 'first' }, { title: 'second' }] }, exec)
    await tool('engineering_team_member_start').execute({ role: 'explorer', label: 'owner', task_id: 't1' }, exec)
    const owner = (await taskRow('t1'))?.owner

    await expect(tool('engineering_team_member_start').execute({ role: 'explorer', label: 'latecomer', task_id: 't1' }, exec))
      .rejects.toThrow(/is claimed by/u)

    const members = await roster()
    expect(members.map(member => member.label)).toEqual(['owner', 'latecomer'])
    const refused = members.find(member => member.label === 'latecomer')
    // `starting` here would be a member the roster shows as coming up forever:
    // there is no handle to stop and no child Agent to dispose.
    expect(refused?.state).toBe('failed')
    expect(refused?.error).toContain('is claimed by')
    // The refusal belongs to the latecomer, and the task kept its real owner.
    expect((await taskRow('t1'))?.owner).toBe(owner)
    runtime.dispose()
  })

  it('lets the same member start again once a free task exists', async () => {
    const { runtime, tool, exec } = harness()
    await tool('engineering_team_plan').execute({ tasks: [{ title: 'first' }, { title: 'second' }] }, exec)
    await tool('engineering_team_member_start').execute({ role: 'explorer', label: 'owner', task_id: 't1' }, exec)
    await expect(tool('engineering_team_member_start').execute({ role: 'explorer', label: 'owner', task_id: 't1' }, exec)).rejects.toThrow()

    const started = await tool('engineering_team_member_start').execute({ role: 'explorer', label: 'owner', task_id: 't2' }, exec)
    expect((started as { task?: { id?: string } }).task?.id).toBe('t2')
    const working = (await roster()).filter(member => member.label === 'owner')
    expect(working.some(member => member.state === 'working' && member.taskId === 't2')).toBe(true)
    runtime.dispose()
  })

  it('starts a member on a role the project defined, not only on the built-in five', async () => {
    // The role library a project owns is not the built-in five: `parseTeamRoles`
    // keeps an id no built-in carries, `mergeTeamRoles` adds it beside them, and
    // `team-roles-context.spec.ts` pins that the merged library resolves it. The
    // one thing that could still make such a role unusable is the *schema* — an
    // `enum` of the built-ins is a guard narrower than the vocabulary it guards,
    // and that is exactly what this case exists to catch.
    await mkdir(join(workspace, '.freecodego'), { recursive: true })
    await writeFile(join(workspace, '.freecodego', 'team-roles.json'), JSON.stringify({
      roles: [{ id: 'auditor', title: 'Auditor', purpose: 'Check the plan against the change.', capabilities: ['read'] }],
    }), 'utf8')
    const { runtime, tool, exec } = harness()
    await tool('engineering_team_plan').execute({ tasks: [{ title: 'only' }] }, exec)

    // The schema is checked directly, not through a call: this case reaches
    // `execute` and so bypasses the validation the Host performs first, which
    // means an `enum` of the built-ins would still let it pass while the model was
    // never offered `auditor`. Comparing the declared vocabulary is what makes the
    // promise structural instead of a claim about today's handler.
    const schema = tool('engineering_team_member_start').parameters as {
      readonly properties?: { readonly role?: { readonly enum?: readonly string[] } }
    }
    expect(schema.properties?.role?.enum).toBeUndefined()

    const started = await tool('engineering_team_member_start').execute({ role: 'auditor', label: 'reviewer', task_id: 't1' }, exec) as { readonly member: TeamMember }
    expect(started.member.role).toBe('auditor')
    expect((await roster()).find(member => member.label === 'reviewer')?.state).toBe('working')

    // An id nothing resolves is still refused — and the refusal names the ids this
    // workspace does resolve, because the schema cannot enumerate them.
    await expect(tool('engineering_team_member_start').execute({ role: 'typo-role', label: 'typo' }, exec))
      .rejects.toThrow(/resolves explorer, architect, implementer, verifier, integrator, auditor/u)
    runtime.dispose()
  })

  it('hands back the isolation of a member that never reached a child Agent', async () => {
    // A writer's worktree is allocated before anything else can fail, and a start
    // that dies before its child Agent exists leaves nothing in it: no work to
    // review and no Agent that could have added any. Keeping it would report a
    // member that never ran as holding unmerged work, with no tool left able to
    // release it.
    await git(workspace, ['init', '-b', 'main'])
    await git(workspace, ['config', 'user.email', 'team@example.test'])
    await git(workspace, ['config', 'user.name', 'Team'])
    await writeFile(join(workspace, 'shared.txt'), 'base\n', 'utf8')
    await git(workspace, ['add', '.'])
    await git(workspace, ['commit', '-m', 'base'])
    const { runtime, tool, exec } = harness({ noAgentService: true })

    await expect(tool('engineering_team_member_start').execute({ role: 'implementer', label: 'unstarted' }, exec))
      .rejects.toThrow(/no agent service/u)

    const worktrees = new TeamWorktrees(workspace, join(teamDirectory(teamRootDirectory(), TEAM_ID), 'worktrees.json'))
    const entries = await worktrees.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.state).toBe('abandoned')
    expect(existsSync(entries[0]?.path ?? '')).toBe(false)
    // The branch survives the hand-back: a release is never the step that
    // destroys work.
    expect((await git(workspace, ['rev-parse', '--verify', '--quiet', entries[0]?.branch ?? ''])).trim()).not.toBe('')
    runtime.dispose()
  })

  it('disposes a child Agent that was created before a later step failed', async () => {
    const { runtime, tool, exec, created } = harness({ followupThrows: true })
    await tool('engineering_team_plan').execute({ tasks: [{ title: 'only' }] }, exec)

    await expect(tool('engineering_team_member_start').execute({ role: 'explorer', label: 'doomed', task_id: 't1' }, exec))
      .rejects.toThrow(/engine refused the brief/u)

    expect(created).toHaveLength(1)
    // Without this the Agent keeps running and spending turns on a brief nobody
    // is waiting for, while the roster already reports the member as failed.
    expect(created[0]?.disposed).toBe(1)
    const doomed = (await roster()).find(member => member.label === 'doomed')
    expect(doomed?.state).toBe('failed')
    expect(doomed?.error).toBe('engine refused the brief')
    // The claim is handed back, so the task is not stranded on a dead member —
    // and the roster must not keep naming it either.
    expect((await taskRow('t1'))?.owner).toBeUndefined()
    expect(doomed?.taskId).toBeUndefined()
    runtime.dispose()
  })

  it('marks a member failed when the composition has no agent service at all', async () => {
    const { runtime, tool, exec } = harness({ noAgentService: true })
    await tool('engineering_team_plan').execute({ tasks: [{ title: 'only' }] }, exec)

    await expect(tool('engineering_team_member_start').execute({ role: 'explorer', label: 'unstartable' }, exec))
      .rejects.toThrow(/no agent service/u)

    const member = (await roster()).find(entry => entry.label === 'unstartable')
    expect(member?.state).toBe('failed')
    expect(member?.error).toContain('no agent service')
    runtime.dispose()
  })
})

describe('team task update member state', () => {
  /** Starts one member holding `t1`, and returns the token the board minted. */
  async function claimed() {
    const started = harness()
    await started.tool('engineering_team_plan').execute({ tasks: [{ title: 'first' }, { title: 'second' }] }, started.exec)
    const result = await started.tool('engineering_team_member_start').execute({ role: 'explorer', label: 'owner', task_id: 't1' }, started.exec) as { member: TeamMember; task: { claimToken: string } }
    return { ...started, member: result.member, claimToken: result.task.claimToken }
  }

  it('drops the recorded task when a member releases it', async () => {
    const { runtime, tool, exec, member, claimToken } = await claimed()
    await tool('engineering_team_task_update').execute({ member: member.id, task_id: 't1', action: 'release', claim_token: claimToken }, exec)

    const recorded = (await roster()).find(entry => entry.id === member.id)
    expect((await taskRow('t1'))?.owner).toBeUndefined()
    // Still naming `t1` here would have the board report a member holding a task
    // that is back in the pool.
    expect(recorded?.taskId).toBeUndefined()
    expect(recorded?.state).toBe('idle')
    runtime.dispose()
  })

  it('drops the recorded task when a member completes it', async () => {
    const { runtime, tool, exec, member, claimToken } = await claimed()
    await tool('engineering_team_task_update').execute({ member: member.id, task_id: 't1', action: 'complete', claim_token: claimToken }, exec)

    const recorded = (await roster()).find(entry => entry.id === member.id)
    expect((await taskRow('t1'))?.status).toBe('done')
    expect(recorded?.taskId).toBeUndefined()
    expect(recorded?.state).toBe('idle')
    runtime.dispose()
  })

  it('stores a review rationale the schema accepted in full rather than half of it', async () => {
    // `note` is one schema property serving eight actions, and the schema states
    // its bound. `approve` applied a different one, so a rationale the schema
    // accepted was stored at half its length and nothing anywhere recorded that
    // half of it had been dropped.
    const { runtime, tool, exec, member, claimToken } = await claimed()
    const rationale = 'x'.repeat(1_500)
    await tool('engineering_team_task_update').execute({ member: member.id, task_id: 't1', action: 'approve', claim_token: claimToken, note: rationale }, exec)

    const approvals = (await taskRow('t1'))?.approvals ?? []
    expect(approvals).toHaveLength(1)
    expect(approvals[0]?.note).toBe(rationale)
    runtime.dispose()
  })

  it('states in the schema the same note bound the board applies', () => {
    // The case above cannot see the two drift: a 1 500-character note fits under
    // the old bound as well as the new one, so it passes whichever number the
    // schema carries. Comparing the values is what turns "one value" into a
    // property instead of a claim about today's code.
    const { runtime, tool } = harness()
    const schema = tool('engineering_team_task_update').parameters as {
      readonly properties?: { readonly note?: { readonly maxLength?: number } }
    }
    expect(schema.properties?.note?.maxLength).toBe(TEAM_NOTE_LIMIT)
    runtime.dispose()
  })

  it('parks a member as waiting, still holding the task it cannot finish', async () => {
    const { runtime, tool, exec, member, claimToken } = await claimed()
    const result = await tool('engineering_team_task_update').execute({
      member: member.id, task_id: 't1', action: 'request_review', claim_token: claimToken,
      note: 'the retry policy is a product decision', waiting_on: 'the user',
    }, exec) as { summary: { needsReview: number; waiting: readonly { readonly on: string }[] } }

    const recorded = (await roster()).find(entry => entry.id === member.id)
    expect((await taskRow('t1'))?.status).toBe('needs-review')
    // Neither working nor available: `working` would claim progress nobody is
    // making, and `idle` would offer the member other work it cannot take.
    expect(recorded?.state).toBe('waiting')
    expect(recorded?.taskId).toBe('t1')
    expect(result.summary.needsReview).toBe(1)
    expect(result.summary.waiting[0]?.on).toBe('the user')
    runtime.dispose()
  })

  it('refuses to park a task with no reason to show the board', async () => {
    const { runtime, tool, exec, member, claimToken } = await claimed()
    await expect(tool('engineering_team_task_update').execute({
      member: member.id, task_id: 't1', action: 'request_review', claim_token: claimToken,
    }, exec)).rejects.toThrow(/needs a note/u)

    // A refused request leaves nothing behind: no parked task, no waiting member.
    expect((await taskRow('t1'))?.status).toBe('claimed')
    expect((await roster()).find(entry => entry.id === member.id)?.state).toBe('working')
    runtime.dispose()
  })

  it('puts a parked member back to work on resume', async () => {
    const { runtime, tool, exec, member, claimToken } = await claimed()
    await tool('engineering_team_task_update').execute({
      member: member.id, task_id: 't1', action: 'request_review', note: 'ask the user', waiting_on: 'the user',
    }, exec)
    await tool('engineering_team_task_update').execute({
      member: member.id, task_id: 't1', action: 'resume', claim_token: claimToken, note: 'the user said retry',
    }, exec)

    expect((await taskRow('t1'))?.status).toBe('claimed')
    expect((await roster()).find(entry => entry.id === member.id)?.state).toBe('working')
    runtime.dispose()
  })

  it('stops reporting a task the previous owner no longer holds after a rerun', async () => {
    const { runtime, tool, exec, member, claimToken } = await claimed()
    await tool('engineering_team_task_update').execute({ member: member.id, task_id: 't1', action: 'fail', claim_token: claimToken, note: 'the fixture hung' }, exec)
    await tool('engineering_team_task_update').execute({ member: member.id, task_id: 't1', action: 'rerun', note: 'the hang was a fixture bug' }, exec)

    const task = await taskRow('t1')
    expect(task?.status).toBe('open')
    expect(task?.owner).toBeUndefined()
    // The reopened task belongs to nobody; a roster row still naming it is the
    // contradiction this clears.
    const recorded = (await roster()).find(entry => entry.id === member.id)
    expect(recorded?.taskId).toBeUndefined()
    expect(recorded?.state).toBe('idle')
    runtime.dispose()
  })

  it('cancels a task nothing will finish, and frees the member that held it', async () => {
    const { runtime, tool, exec, member } = await claimed()
    const result = await tool('engineering_team_task_update').execute({
      member: member.id, task_id: 't1', action: 'cancel', note: 'the objective changed',
    }, exec) as { task: { status: string; note: string } }

    expect((await taskRow('t1'))?.status).toBe('cancelled')
    expect(result.task.note).toBe('the objective changed')
    // A closed task is not the member's to work on, so a roster row still naming
    // it is the contradiction this clears — the same one the hand-back paths clear.
    const recorded = (await roster()).find(entry => entry.id === member.id)
    expect(recorded?.taskId).toBeUndefined()
    expect(recorded?.state).toBe('idle')
    runtime.dispose()
  })

  it('reopens a cancelled task under the same id, which is what the description promises', async () => {
    const { runtime, tool, exec, member } = await claimed()
    await tool('engineering_team_task_update').execute({ member: member.id, task_id: 't1', action: 'cancel' }, exec)
    // `rerun`'s contract names both halves — "a failed or cancelled task" — and
    // only the failed half had a way to be produced.
    await tool('engineering_team_task_update').execute({ member: member.id, task_id: 't1', action: 'rerun', note: 'the objective is back' }, exec)

    const task = await taskRow('t1')
    expect(task?.status).toBe('open')
    expect(task?.owner).toBeUndefined()
    runtime.dispose()
  })

  it('offers cancel in the schema, so a board status nothing could reach is reachable', async () => {
    const { runtime, tool } = harness()
    const schema = tool('engineering_team_task_update').parameters as {
      readonly properties?: { readonly action?: { readonly enum?: readonly string[] } }
    }
    // `cancelled` is in `TEAM_TASK_STATUSES`, counted by the board summary, and
    // named by `rerun`'s contract, but `TeamBoard.cancel` had no caller in the
    // plugin at all: the status and the method were reachable from a spec and
    // from nowhere a user or an Agent could touch.
    expect(schema.properties?.action?.enum).toContain('cancel')
    runtime.dispose()
  })

  it('reports the locked isolation field set for a live writer, read from the record', async () => {
    await git(workspace, ['init', '-b', 'main'])
    await git(workspace, ['config', 'user.email', 'team@example.test'])
    await git(workspace, ['config', 'user.name', 'Team'])
    await writeFile(join(workspace, 'shared.txt'), 'base\n', 'utf8')
    await git(workspace, ['add', '.'])
    await git(workspace, ['commit', '-m', 'base'])
    const { runtime, tool, exec } = harness()
    await tool('engineering_team_plan').execute({ tasks: [{ title: 'write it' }] }, exec)
    await tool('engineering_team_member_start').execute({ role: 'implementer', label: 'writer', task_id: 't1' }, exec)

    const report = await tool('engineering_team_recover').execute({}, exec) as {
      readonly worktrees: readonly {
        readonly id: string
        readonly memberId: string
        readonly isolation: Readonly<Record<string, unknown>>
        readonly isolationFields: readonly string[]
      }[]
    }
    expect(report.worktrees).toHaveLength(1)
    const row = report.worktrees[0]
    if (row === undefined) throw new Error('the report listed no worktree for the isolated writer')
    // The report carries the locked list, and the row carries exactly those keys:
    // a field added to the record and left out of the report is a failing
    // assertion here rather than a fact nobody can read.
    expect(row.isolationFields).toEqual([...LOCKED_ISOLATION_FIELDS])
    expect(Object.keys(row.isolation).sort()).toEqual([...LOCKED_ISOLATION_FIELDS].sort())
    // A restarted Host reads the copy's location and branch from the record. The
    // directory name is what these fields replace, so they are checked against the
    // record's own values rather than against a second derivation of the slug.
    expect(row.isolation.worktreePath).toBe(row.isolation.workingDir)
    expect(String(row.isolation.worktreePath)).toContain(join('.freecodego', 'worktrees'))
    expect(row.isolation.worktreeBranch).toBe(`freecodego/team/${row.memberId}`)
    expect(row.isolation.worktreeDetached).toBe(false)
    expect(row.isolation.worktreeMode).toBe('git')
    expect(row.isolation.workspaceMode).toBe('worktree')
    expect(row.isolation.worktreeState).toBe('active')
    expect(row.isolation.worktreeRepoRoot).toBe(workspace)
    expect(row.isolation.teamStateRoot).toBe(teamDirectory(teamRootDirectory(), TEAM_ID))
    expect(Number(row.isolation.worktreeCreated)).toBeGreaterThan(0)
    runtime.dispose()
  })

  it('merges an isolated writer by the durable member id', async () => {
    await git(workspace, ['init', '-b', 'main'])
    await git(workspace, ['config', 'user.email', 'team@example.test'])
    await git(workspace, ['config', 'user.name', 'Team'])
    await writeFile(join(workspace, 'shared.txt'), 'base\n', 'utf8')
    await git(workspace, ['add', '.'])
    await git(workspace, ['commit', '-m', 'base'])
    const { runtime, tool, exec } = harness()
    const started = await tool('engineering_team_member_start').execute({ role: 'implementer', label: 'writer' }, exec) as { readonly member: TeamMember }
    const member = (await roster()).find(entry => entry.id === started.member.id)
    if (member?.worktree === undefined) throw new Error('the writer did not retain its worktree path')
    await writeFile(join(member.worktree, 'feature.txt'), 'from writer\n', 'utf8')
    await git(member.worktree, ['add', '.'])
    await git(member.worktree, ['commit', '-m', 'feature'])

    const merged = await tool('engineering_team_merge').execute({ member: started.member.id }, exec) as { readonly merged: boolean }
    expect(merged.merged).toBe(true)
    expect((await import('node:fs/promises').then(fs => fs.readFile(join(workspace, 'feature.txt'), 'utf8'))).replaceAll('\r\n', '\n')).toBe('from writer\n')
    runtime.dispose()
  })

  it('stops naming a task its member handed back by stopping', async () => {
    // The roster is what the board answers "the task each member holds" from, so a
    // member that handed its task back must stop naming it. `complete`, `release`
    // and `rerun` all clear it; `member_stop` was the fourth hand-back and the one
    // left out, which made `recover` report a member holding a task the board had
    // already returned to the pool.
    const { runtime, tool, exec, member } = await claimed()
    const stopped = await tool('engineering_team_member_stop').execute({ member: member.id, reason: 'enough' }, exec) as {
      readonly released?: { readonly status: string; readonly owner?: string }
    }

    expect(stopped.released?.status).toBe('open')
    expect(stopped.released?.owner).toBeUndefined()
    expect((await taskRow('t1'))?.owner).toBeUndefined()
    const recorded = (await roster()).find(entry => entry.id === member.id)
    expect(recorded?.state).toBe('stopped')
    expect(recorded?.taskId).toBeUndefined()
    runtime.dispose()
  })
})

describe('team board read window', () => {
  /** A board of `count` tasks, written straight to the file the tool reads. */
  async function boardOf(count: number): Promise<TeamBoard> {
    const board = new TeamBoard(TEAM_ID, join(teamDirectory(teamRootDirectory(), TEAM_ID), 'board.json'))
    await board.create({ createdBy: 'parent', tasks: Array.from({ length: count }, (_unused, index) => ({ title: `task ${index + 1}` })) })
    return board
  }

  interface BoardRead {
    readonly tasks: readonly unknown[]
    readonly tasksMatching: number
    readonly tasksShown: number
    readonly summary: { readonly total: number }
  }

  it('says how many tasks the window was cut from, so a partial list is not read as the board', async () => {
    // The board accumulates — `engineering_team_plan` caps one call at forty and
    // says the tasks already there stay — so a long-lived team outgrows one
    // answer. The read was a bare `slice(0, 60)` under a description promising
    // "every task", so a busy board answered with the sixty oldest ids and nothing
    // in the payload said the rest existed.
    const { runtime, tool, exec } = harness()
    await boardOf(70)

    const read = await tool('engineering_team_board').execute({}, exec) as BoardRead

    expect(read.tasksMatching).toBe(70)
    expect(read.tasksShown).toBe(60)
    expect(read.tasks).toHaveLength(60)
    runtime.dispose()
  })

  it('counts the list the filter left, not the board, when completed tasks are left out', async () => {
    // This is why `summary.total` cannot be the number that answers the question:
    // it counts every task on the board, while the window is cut from the tasks
    // `include_done: false` kept. Here the board holds seventy and the read is over
    // sixty, so a reader comparing `summary.total` with the list would conclude
    // ten tasks were left out when none were.
    const { runtime, tool, exec } = harness()
    const board = await boardOf(70)
    for (let index = 1; index <= 10; index += 1) {
      const id = `t${String(index)}`
      await board.claim(id, 'parent')
      await board.complete(id, 'parent')
    }

    const read = await tool('engineering_team_board').execute({ include_done: false }, exec) as BoardRead

    expect(read.summary.total).toBe(70)
    expect(read.tasksMatching).toBe(60)
    expect(read.tasksShown).toBe(60)
    expect(read.tasks).toHaveLength(60)
    runtime.dispose()
  })
})
