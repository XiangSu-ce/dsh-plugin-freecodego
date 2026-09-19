import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { keepRecentBoundary, TeamContextControl, type ContextControlAgent } from '../src/team/context.ts'
import { isDeferrableByPrefix } from '../src/deferred-tools.ts'
import { BUILT_IN_TEAM_ROLES,
  loadProjectTeamRoles,
  mergeTeamRoles,
  parseTeamRoles,
  resolveRoleTools,
  roleInstructions,
  teamRoleById,
} from '../src/team/roles.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

const AVAILABLE = ['read', 'grep', 'glob', 'write', 'edit', 'bash', 'engineering_team_verify', 'engineering_team_member_start', 'freecodego_generate_image']

/**
 * The mutating names a harness may offer that this fixture used not to carry.
 *
 * `resolveRoleTools` decides by name, and the list it decides from is curated
 * rather than discovered — so a name the list is missing is not an inert entry,
 * it is a read-only role holding a tool that deletes a file. These are the six
 * the team role list was missing; keeping them here is what makes the guard's
 * coverage visible rather than implied by a fixture that only ever offered
 * `write` and `edit`.
 */
const MUTATING_NAMES = ['notebook_write', 'str_replace_editor', 'delete_file', 'move_file', 'fs_write', 'fs_edit']

describe('team role library', () => {
  it('never hands a write or shell tool to a read-only role, even when named explicitly', () => {
    // The allow list is intersected with capabilities, so a project file cannot
    // promote the explorer into an implementer by listing a write tool.
    const explorer = { ...teamRoleById(BUILT_IN_TEAM_ROLES, 'explorer')!, toolAllow: ['write', 'edit', 'bash', 'read'] }
    expect(resolveRoleTools(explorer, AVAILABLE)).toEqual(['read'])
  })

  it('withholds the mutating names this fixture used not to carry', () => {
    // Every one of these mutates, so a read-only role must not receive it —
    // whatever the harness happens to call it. The second half is the control:
    // a role that *may* write must receive all six, otherwise a guard that
    // simply dropped every tool would satisfy the first assertion too.
    const explorer = teamRoleById(BUILT_IN_TEAM_ROLES, 'explorer')!
    expect(resolveRoleTools(explorer, MUTATING_NAMES)).toEqual([])
    const implementer = teamRoleById(BUILT_IN_TEAM_ROLES, 'implementer')!
    expect(resolveRoleTools(implementer, MUTATING_NAMES)).toEqual(MUTATING_NAMES)
  })

  it('withholds the plugin\u2019s own tree-changing names, which no sandbox gates', () => {
    // The second half of the same rule. `resolveRoleTools` decides by name, and
    // these four write through this plugin's own code path rather than through the
    // harness's `edit`/`write` — so read-only sandbox mode, a harness policy its
    // own tools consult, does not stand behind the fence for them.
    const pluginWriters = ['edit_and_run', 'engineering_checkpoint_restore', 'engineering_hunk_revert', 'engineering_team_merge']
    expect(resolveRoleTools(teamRoleById(BUILT_IN_TEAM_ROLES, 'verifier')!, pluginWriters)).toEqual([])
    expect(resolveRoleTools(teamRoleById(BUILT_IN_TEAM_ROLES, 'explorer')!, pluginWriters)).toEqual([])
    // The control: a role that may write keeps all four, so a guard that dropped
    // every tool would not satisfy the assertion above.
    expect(resolveRoleTools(teamRoleById(BUILT_IN_TEAM_ROLES, 'implementer')!, pluginWriters)).toEqual(pluginWriters)
        // The integrator is the role whose job is the merge.
    expect(resolveRoleTools(teamRoleById(BUILT_IN_TEAM_ROLES, 'integrator')!, pluginWriters)).toContain('engineering_team_merge')
  })

  it('holds delegation to the role that declares the capability', () => {
    // `delegate` was the one capability no rule read, so the fence was the
    // explorer's hand-written `toolDeny` — complete for the three spellings it
    // named, silent about `engineering_subagent_start` and about every harness
    // spelling. A member that can start a writer is a writer one call removed.
    const delegation = ['subagent', 'subagent_fork', 'workflow', 'ralph', 'spawn_teammate', 'send_message', 'engineering_subagent_start', 'engineering_team_member_start', 'engineering_team_start', 'engineering_council_review']
    for (const id of ['explorer', 'implementer', 'verifier', 'integrator']) {
      expect(resolveRoleTools(teamRoleById(BUILT_IN_TEAM_ROLES, id)!, delegation), id).toEqual([])
    }
    // The architect lays the work out, so it is the role that hands it out.
    expect(resolveRoleTools(teamRoleById(BUILT_IN_TEAM_ROLES, 'architect')!, delegation)).toEqual(delegation)
    // An explicit deny still removes from a role that may delegate, which is what
    // keeps `toolDeny` the mechanism for tightening rather than the fence itself.
    const narrowed = { ...teamRoleById(BUILT_IN_TEAM_ROLES, 'architect')!, toolDeny: ['workflow'] }
    expect(resolveRoleTools(narrowed, delegation)).not.toContain('workflow')
  })

  it('gives the implementer the workspace tools it needs and withholds verification', () => {
    const implementer = teamRoleById(BUILT_IN_TEAM_ROLES, 'implementer')!
    const allowed = resolveRoleTools(implementer, AVAILABLE)
    expect(allowed).toContain('write')
    expect(allowed).toContain('bash')
    // The implementer may not close out its own work as verified.
    expect(allowed).not.toContain('engineering_team_verify')
  })

  it('keeps the verifier read-only on disk while letting it run probes', () => {
    const verifier = teamRoleById(BUILT_IN_TEAM_ROLES, 'verifier')!
    expect(verifier.sandbox).toBe('read-only')
    const allowed = resolveRoleTools(verifier, AVAILABLE)
    expect(allowed).toContain('bash')
    expect(allowed).not.toContain('write')
    expect(allowed).not.toContain('edit')
    // `engineering_team_verify` is still its own tool: the fence is about writes,
    // not about the review surface it exists to use.
    expect(allowed).toContain('engineering_team_verify')
  })

  it('states what every built-in role is not responsible for', () => {
    for (const role of BUILT_IN_TEAM_ROLES) {
      expect(role.notResponsibleFor.length).toBeGreaterThan(0)
      expect(role.reports.length).toBeGreaterThan(0)
      expect(role.maxTurns).toBeGreaterThan(0)
    }
  })

  it('lets a project override a built-in role and add a new one', () => {
    const overrides = parseTeamRoles([
      { id: 'implementer', capabilities: ['read'], purpose: 'read only here' },
      { id: 'auditor', title: 'Auditor', capabilities: ['read'], reports: ['findings'] },
    ])
    const merged = mergeTeamRoles(overrides)
    expect(teamRoleById(merged, 'implementer')?.purpose).toBe('read only here')
    // A tightened role cannot write, so its tools resolve to reads only. The list
    // used to carry `engineering_team_member_start`, which starts a member: this
    // expectation was written from the behaviour rather than from the sentence
    // above it, and the behaviour was the hole — `delegate` was a declared
    // capability that no rule read, so a read-only role held every spelling of
    // "start another Agent" that its `toolDeny` did not happen to name.
    expect(resolveRoleTools(teamRoleById(merged, 'implementer')!, AVAILABLE)).toEqual(['read', 'grep', 'glob', 'engineering_team_verify', 'freecodego_generate_image'])
    expect(teamRoleById(merged, 'auditor')).toMatchObject({ title: 'Auditor', sandbox: 'read-only' })
    expect(teamRoleById(merged, 'explorer')).toBeDefined()
  })

  it('refuses a workspace-write sandbox on a role that cannot write', () => {
    const roles = parseTeamRoles([{ id: 'peeker', capabilities: ['read'], sandbox: 'workspace-write' }])
    expect(roles[0]?.sandbox).toBe('read-only')
  })

  it('drops malformed role entries instead of throwing', () => {
    expect(parseTeamRoles([null, 42, { capabilities: ['read'] }, { id: '  ' }])).toEqual([])
    expect(parseTeamRoles('nonsense')).toEqual([])
  })

  it('reads project roles from the workspace and tolerates a missing or broken file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'freecodego-team-roles-'))
    directories.push(cwd)
    expect(await loadProjectTeamRoles(cwd)).toEqual([])
    await mkdir(join(cwd, '.freecodego'), { recursive: true })
    await writeFile(join(cwd, '.freecodego', 'team-roles.json'), '{ not json', 'utf8')
    expect(await loadProjectTeamRoles(cwd)).toEqual([])
    await writeFile(join(cwd, '.freecodego', 'team-roles.json'), JSON.stringify({ roles: [{ id: 'scribe', capabilities: ['read'] }] }), 'utf8')
    expect((await loadProjectTeamRoles(cwd)).map(role => role.id)).toEqual(['scribe'])
  })

  it('writes the role boundary and report contract into the member brief', () => {
    const brief = roleInstructions(teamRoleById(BUILT_IN_TEAM_ROLES, 'verifier')!, { task: { id: 't2', title: 'verify the parser', detail: 'check the empty input path' } })
    expect(brief).toContain('NOT responsible')
    expect(brief).toContain('t2')
    expect(brief).toContain('probes')
    expect(brief).toContain('Keep each to a few lines')
  })

  it('hands the member the claim token that closing its task requires', () => {
    // A claimed task is only closable with the token the board minted for that
    // claim, so a brief that names the task but withholds the token hands the
    // member work it cannot finish. This pins the hand-off, not the wording.
    const withToken = roleInstructions(teamRoleById(BUILT_IN_TEAM_ROLES, 'implementer')!, {
      task: { id: 't3', title: 'add the parser', detail: '', claimToken: 'c_abc123' },
    })
    expect(withToken).toContain('c_abc123')
    // A task with no token must not claim there is one to present.
    const withoutToken = roleInstructions(teamRoleById(BUILT_IN_TEAM_ROLES, 'implementer')!, {
      task: { id: 't3', title: 'add the parser', detail: '' },
    })
    expect(withoutToken).not.toContain('claim_token')
  })

  it('tells the member how to reach a team tool deferral withholds', () => {
    // The premise: member tooling lives in the deferred families, so the brief's
    // instruction to close the task with `engineering_team_task_update` names a
    // tool that is *not* in the member's schema. Telling a model to call a tool
    // and withholding its schema — without saying how to load it — is the one
    // instruction shape this plugin treats as a defect: the member's first call
    // is refused, and a member that cannot close its task keeps holding it.
    expect(isDeferrableByPrefix('engineering_team_task_update')).toBe(true)
    const brief = roleInstructions(teamRoleById(BUILT_IN_TEAM_ROLES, 'implementer')!, {
      task: { id: 't1', title: 'add the parser', detail: '', claimToken: 'c_abc123' },
    })
    expect(brief).toContain('tool_search')
    expect(brief).toContain('select:engineering_team_task_update')
    // A member with no claim token is never told to close anything, so it must
    // not be handed the fetch instruction either.
    const withoutToken = roleInstructions(teamRoleById(BUILT_IN_TEAM_ROLES, 'implementer')!, {
      task: { id: 't1', title: 'add the parser', detail: '' },
    })
    expect(withoutToken).not.toContain('tool_search')
  })

  it('does not promise members a peer channel that does not exist', () => {
    const brief = roleInstructions(teamRoleById(BUILT_IN_TEAM_ROLES, 'implementer')!, { teammates: ['explorer', 'verifier'] })
    expect(brief).toContain('explorer')
    expect(brief).not.toMatch(/mail/i)
  })
})

describe('manual context control', () => {
  const agent = (events: readonly { readonly seq: number; readonly type: string }[]): ContextControlAgent => ({
    session: { snapshotEvents: () => events },
  })

  it('bounds a snip to whole assistant turns, ignoring tool results', () => {
    const boundary = keepRecentBoundary(agent([
      { seq: 1, type: 'user/message' },
      { seq: 2, type: 'assistant/message' },
      { seq: 3, type: 'tool/result' },
      { seq: 4, type: 'tool/result' },
      { seq: 5, type: 'assistant/message' },
      { seq: 6, type: 'assistant/message' },
    ]), 1)
    // Keeping the last turn means keeping seq 6, so the span ends at the
    // assistant message before it (seq 5) — tool results never extend it.
    expect(boundary).toEqual({ start: 1, end: 5 })
    // Keeping two turns keeps seqs 5 and 6, so the span ends at seq 4.
    expect(keepRecentBoundary(agent([
      { seq: 1, type: 'user/message' },
      { seq: 2, type: 'assistant/message' },
      { seq: 4, type: 'tool/result' },
      { seq: 5, type: 'assistant/message' },
      { seq: 6, type: 'assistant/message' },
    ]), 2)).toEqual({ start: 1, end: 4 })
  })

  it('refuses to snip when there is no earlier turn to drop', () => {
    expect(keepRecentBoundary(agent([{ seq: 1, type: 'assistant/message' }]), 1)).toBeUndefined()
    expect(keepRecentBoundary(agent([]), 2)).toBeUndefined()
  })

  it('says compaction is unavailable rather than pretending it ran', async () => {
    const control = new TeamContextControl({ get: () => undefined } as unknown as Context)
    expect(control.available().ok).toBe(false)
    const result = await control.compactNow(agent([]), new AbortController().signal)
    expect(result).toMatchObject({ changed: false })
    expect(result.detail).toContain('no compaction engine')
    expect(await control.snip(agent([]), { keepRecentTurns: 1 }, new AbortController().signal)).toMatchObject({ changed: false })
  })

  it('treats a null result from the engine as "nothing safe to replace", not success', async () => {
    const compactNow = vi.fn().mockResolvedValue(null)
    const control = new TeamContextControl({ get: () => ({ compactNow, compactRegion: vi.fn() }) } as unknown as Context)
    expect(control.available().ok).toBe(true)
    expect(await control.compactNow(agent([]), new AbortController().signal)).toMatchObject({ changed: false })
    expect(compactNow).toHaveBeenCalledOnce()
  })

  it('reports the replaced span a snip actually produced', async () => {
    const compactRegion = vi.fn().mockResolvedValue({ compactionId: 'c1', shadowedRange: { start: 1, end: 4 } })
    const control = new TeamContextControl({ get: () => ({ compactNow: vi.fn(), compactRegion }) } as unknown as Context)
    const result = await control.snip(agent([
      { seq: 1, type: 'assistant/message' },
      { seq: 2, type: 'assistant/message' },
    ]), { keepRecentTurns: 1 }, new AbortController().signal)
    expect(compactRegion).toHaveBeenCalledWith(1, 1, expect.anything(), expect.anything())
    expect(result).toMatchObject({ action: 'snip', changed: true, compactionId: 'c1' })
  })

  it('passes explicit seqs straight through without consulting the session', async () => {
    const compactRegion = vi.fn().mockResolvedValue({})
    const control = new TeamContextControl({ get: () => ({ compactNow: vi.fn(), compactRegion }) } as unknown as Context)
    await control.snip(agent([]), { start: 2, end: 8 }, new AbortController().signal)
    expect(compactRegion).toHaveBeenCalledWith(2, 8, expect.anything(), expect.anything())
  })

  it('keeps the endpoint the caller gave and derives only the one it did not', async () => {
    // The tool schema says each seq is for "when you know it", so one endpoint is
    // a request rather than an incomplete pair. Treating it as unknown discarded
    // it and replaced a *wider* span than the caller chose — the direction of
    // error that loses history — while the answer still reported the span it had
    // actually used.
    const compactRegion = vi.fn().mockResolvedValue({})
    const control = new TeamContextControl({ get: () => ({ compactNow: vi.fn(), compactRegion }) } as unknown as Context)
    const session = agent([
      { seq: 1, type: 'user/message' },
      { seq: 2, type: 'assistant/message' },
      { seq: 3, type: 'tool/result' },
      { seq: 4, type: 'assistant/message' },
    ])
    // Keeping the last turn puts the derived end at seq 3, so a lone `start` of 20
    // must reach the engine as (20, 3) and be its refusal to make — not silently
    // become (1, 3).
    const loneStart = await control.snip(session, { start: 20, keepRecentTurns: 1 }, new AbortController().signal)
    expect(compactRegion).toHaveBeenLastCalledWith(20, 3, expect.anything(), expect.anything())
    expect(loneStart.detail).toContain('20..3')
    // And a lone `end` keeps the start the boundary derives.
    await control.snip(session, { end: 2, keepRecentTurns: 1 }, new AbortController().signal)
    expect(compactRegion).toHaveBeenLastCalledWith(1, 2, expect.anything(), expect.anything())
  })
})
