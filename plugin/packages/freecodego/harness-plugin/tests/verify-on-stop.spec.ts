/**
 * The gate exists to make an omission visible, so the tests are about the four
 * ways it could become either useless or noisy: firing on a turn that changed
 * nothing, firing twice for one change set, being satisfied by a stale or
 * failed verification, and naming a tool the model cannot call.
 */

import { describe, expect, it } from 'vitest'
import { PLAN_MODE_MUTATING_TOOLS } from '../src/plan-mode.ts'
import {
  buildVerifyOnStopNudge,
  FreeCodeGoVerifyOnStop,
  VERIFICATION_TOOL_NAME,
  WORKSPACE_MUTATING_TOOLS,
  workspaceFingerprint,
  type VerifyOnStopEvidence,
} from '../src/verify-on-stop.ts'

function gate(options: {
  readonly enabled?: boolean
  readonly changedPaths?: readonly string[]
  readonly failing?: boolean
  /** Content digest of the workspace, as the host reads it. */
  readonly revision?: string
  /** A host with no repository behind the workspace: it cannot answer at all. */
  readonly revisionUnreadable?: boolean
} = {}): {
  readonly service: FreeCodeGoVerifyOnStop
  readonly injected: { readonly agentId: string; readonly text: string }[]
  readonly reads: () => number
  readonly logs: readonly string[]
} {
  const injected: { agentId: string; text: string }[] = []
  const logs: string[] = []
  let reads = 0
  const service = new FreeCodeGoVerifyOnStop({
    enabled: () => options.enabled ?? true,
    readChangedPaths: async () => {
      reads += 1
      if (options.failing === true) throw new Error('git is unavailable')
      return options.changedPaths ?? ['src/a.ts']
    },
    readChangeRevision: async () => options.revisionUnreadable === true ? undefined : options.revision ?? 'rev-1',
    inject: (agentId, text) => { injected.push({ agentId, text }) },
    log: (message) => { logs.push(message) },
  })
  return { service, injected, reads: () => reads, logs }
}

describe('verify-on-stop gate', () => {
  it('says nothing about a turn that changed nothing, and never reads the workspace', async () => {
    const harness = gate()
    await harness.service.onTurnStopping('agent-1')
    expect(harness.injected).toEqual([])
    // The point is the cost too: a conversation-only turn runs no `git`.
    expect(harness.reads()).toBe(0)
  })

  it('nudges once when a mutating tool ran and no verification was recorded', async () => {
    const harness = gate({ changedPaths: ['src/a.ts', 'src/b.ts'] })
    harness.service.noteToolCall('agent-1', 'edit')
    await harness.service.onTurnStopping('agent-1')
    expect(harness.injected).toHaveLength(1)
    expect(harness.injected[0]?.agentId).toBe('agent-1')
    expect(harness.injected[0]?.text).toContain('src/a.ts, src/b.ts')
    expect(harness.injected[0]?.text).toContain('No verification was recorded')
  })

  it('does not nudge twice for the same change set', async () => {
    const harness = gate()
    harness.service.noteToolCall('agent-1', 'edit')
    await harness.service.onTurnStopping('agent-1')
    harness.service.noteToolCall('agent-1', 'edit')
    await harness.service.onTurnStopping('agent-1')
    expect(harness.injected).toHaveLength(1)
  })

  it('nudges again once the change set moves on', async () => {
    // The changed paths move under the service, which the `gate()` fixture
    // cannot express: it pins one set for the whole test.
    // Paths and content move together, which is the only way they can move: a new
    // path is part of the diff, so the revision cannot stay put while the path set
    // changes. The `gate()` fixture pins one state for the whole test, which is
    // why this case builds its own host.
    const moving: { paths: string[]; revision: string } = { paths: ['src/a.ts'], revision: 'rev-a' }
    const seen: string[] = []
    const service = new FreeCodeGoVerifyOnStop({
      enabled: () => true,
      readChangedPaths: async () => moving.paths,
      readChangeRevision: async () => moving.revision,
      inject: (_agentId, text) => { seen.push(text) },
      log: () => undefined,
    })
    service.noteToolCall('agent-1', 'edit')
    await service.onTurnStopping('agent-1')
    moving.paths = ['src/a.ts', 'src/c.ts']
    moving.revision = 'rev-b'
    service.noteToolCall('agent-1', 'edit')
    await service.onTurnStopping('agent-1')
    expect(seen).toHaveLength(2)
    expect(seen[1]).toContain('src/c.ts')
  })

  it('stays quiet when a passing verification covered exactly this change', async () => {
    const harness = gate({ changedPaths: ['src/a.ts'] })
    harness.service.recordEvidence('agent-1', { verdict: 'verified', changedPaths: ['src/a.ts'], revision: 'rev-1' })
    harness.service.noteToolCall('agent-1', 'edit')
    await harness.service.onTurnStopping('agent-1')
    expect(harness.injected).toEqual([])
  })

  it('treats a verification of a different change set as no verification at all', async () => {
    // The recorded state is the one from before `src/new.ts` existed, so the two
    // identities differ in both of their halves — as they must: a different path
    // set is a different diff, and a content identity therefore can never agree
    // while the paths disagree.
    const harness = gate({ changedPaths: ['src/a.ts', 'src/new.ts'] })
    harness.service.recordEvidence('agent-1', { verdict: 'verified', changedPaths: ['src/a.ts'], revision: 'rev-before' })
    harness.service.noteToolCall('agent-1', 'edit')
    await harness.service.onTurnStopping('agent-1')
    expect(harness.injected).toHaveLength(1)
    expect(harness.injected[0]?.text).toContain('not for the workspace as it stands now')
  })

  it('does not let a re-edit of an already-modified file pass as verified', async () => {
    // The hole a path list leaves open: `src/a.ts` is modified, a verification
    // records exactly that path set, and the file is edited *again* — no new path,
    // no new status letter, the same fingerprint — so the second, unverified
    // state walked through the gate as a verified one. Nothing about the paths
    // distinguishes the two states; only their content does.
    const workspace = { revision: 'rev-a' }
    const seen: string[] = []
    const service = new FreeCodeGoVerifyOnStop({
      enabled: () => true,
      readChangedPaths: async () => ['src/a.ts'],
      readChangeRevision: async () => workspace.revision,
      inject: (_agentId, text) => { seen.push(text) },
      log: () => undefined,
    })
    await service.recordVerification('agent-1', 'verified')
    service.noteToolCall('agent-1', 'edit')
    await service.onTurnStopping('agent-1')
    expect(seen).toEqual([])
    workspace.revision = 'rev-b'
    service.noteToolCall('agent-1', 'edit')
    await service.onTurnStopping('agent-1')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('not for the workspace as it stands now')
  })

  it('nudges again when the same paths are edited again after the first nudge', async () => {
    // The latch half of the same hole: keyed on paths alone, the second edit of an
    // already-modified file looked like a repetition of the first nudge and was
    // swallowed — including the honest first nudge, which had said this change
    // was unverified.
    const workspace = { revision: 'rev-a' }
    const seen: string[] = []
    const service = new FreeCodeGoVerifyOnStop({
      enabled: () => true,
      readChangedPaths: async () => ['src/a.ts'],
      readChangeRevision: async () => workspace.revision,
      inject: (_agentId, text) => { seen.push(text) },
      log: () => undefined,
    })
    service.noteToolCall('agent-1', 'edit')
    await service.onTurnStopping('agent-1')
    workspace.revision = 'rev-b'
    service.noteToolCall('agent-1', 'edit')
    await service.onTurnStopping('agent-1')
    expect(seen).toHaveLength(2)
  })

  it('falls back to the path identity when the workspace has no revision to read', async () => {
    // A workspace with no repository behind it: the gate keeps the weaker claim it
    // has always made — same paths, no content answer — rather than refusing ever
    // to be satisfied, which would nudge every turn after a real verification.
    const harness = gate({ changedPaths: ['src/a.ts'], revisionUnreadable: true })
    await harness.service.recordVerification('agent-1', 'verified')
    harness.service.noteToolCall('agent-1', 'edit')
    await harness.service.onTurnStopping('agent-1')
    expect(harness.injected).toEqual([])
  })

  it('does not let a paths-only record cover a workspace whose content it never measured', async () => {
    // The primitive is still reachable, so the rule has to hold at it: an
    // identity built from paths is never equal to one built from content, because
    // "cannot be shown to cover" is not "covered".
    const harness = gate({ changedPaths: ['src/a.ts'] })
    harness.service.recordEvidence('agent-1', { verdict: 'verified', changedPaths: ['src/a.ts'] })
    harness.service.noteToolCall('agent-1', 'edit')
    await harness.service.onTurnStopping('agent-1')
    expect(harness.injected).toHaveLength(1)
    expect(harness.injected[0]?.text).toContain('not for the workspace as it stands now')
  })

  it('does not accept an unverified or failed run as evidence', async () => {
    for (const verdict of ['unverified', 'failed'] as const) {
      const harness = gate({ changedPaths: ['src/a.ts'] })
      const evidence: VerifyOnStopEvidence = { verdict, changedPaths: ['src/a.ts'] }
      harness.service.recordEvidence('agent-1', evidence)
      harness.service.noteToolCall('agent-1', 'edit')
      await harness.service.onTurnStopping('agent-1')
      expect(harness.injected).toHaveLength(1)
      expect(harness.injected[0]?.text).toContain(verdict.toUpperCase())
    }
  })

  it('reads the workspace of the agent whose turn is ending, not a global one', async () => {
    // Two sessions in one process have two `cwd`s, so the gate must ask per
    // agent; asking for "the workspace" would nudge about someone else's change.
    const asked: string[] = []
    const service = new FreeCodeGoVerifyOnStop({
      enabled: () => true,
      readChangedPaths: async (agentId) => {
        asked.push(agentId)
        return agentId === 'agent-b' ? ['src/b.ts'] : []
      },
      readChangeRevision: async () => 'rev-1',
      inject: () => undefined,
      log: () => undefined,
    })
    service.noteToolCall('agent-a', 'edit')
    service.noteToolCall('agent-b', 'edit')
    await service.onTurnStopping('agent-a')
    await service.onTurnStopping('agent-b')
    expect(asked).toEqual(['agent-a', 'agent-b'])
  })

  it('forgets what it knew about a disposed agent instead of reusing the id', async () => {
    const harness = gate()
    harness.service.noteToolCall('agent-1', 'edit')
    await harness.service.onTurnStopping('agent-1')
    harness.service.forget('agent-1')
    // The same id, a new agent: the latch must not suppress the new turn's nudge.
    harness.service.noteToolCall('agent-1', 'edit')
    await harness.service.onTurnStopping('agent-1')
    expect(harness.injected).toHaveLength(2)
  })

  it('stays silent when the switch is off', async () => {
    const harness = gate({ enabled: false })
    harness.service.noteToolCall('agent-1', 'edit')
    await harness.service.onTurnStopping('agent-1')
    expect(harness.injected).toEqual([])
  })

  it('logs a workspace read failure instead of failing the turn', async () => {
    const harness = gate({ failing: true })
    harness.service.noteToolCall('agent-1', 'edit')
    await expect(harness.service.onTurnStopping('agent-1')).resolves.toBeUndefined()
    expect(harness.injected).toEqual([])
    expect(harness.logs.join(' ')).toContain('could not read the workspace')
  })

  it('ignores tools that do not change workspace content', async () => {
    const harness = gate()
    harness.service.noteToolCall('agent-1', 'read')
    harness.service.noteToolCall('agent-1', 'grep')
    await harness.service.onTurnStopping('agent-1')
    expect(harness.reads()).toBe(0)
  })

  it('counts a checkpoint restore as a mutation', async () => {
    const harness = gate()
    harness.service.noteToolCall('agent-1', 'engineering_checkpoint_restore')
    await harness.service.onTurnStopping('agent-1')
    expect(harness.injected).toHaveLength(1)
  })

  it('counts the plugin tools that write the shared tree as mutations', async () => {
    // Both change tracked files through a path the harness's own write tools never
    // see: a revert lands new bytes in the file it undoes, and a merge runs
    // `git merge` at the workspace root. Absent from the set, a turn that did only
    // that was filed as one that changed nothing, `onTurnStopping` returned before
    // it read anything, and the change went unverified — the hole `multi_edit`
    // already fell through once, in the same shape.
    for (const tool of ['engineering_hunk_revert', 'engineering_team_merge']) {
      const harness = gate({ changedPaths: ['src/a.ts'] })
      harness.service.noteToolCall('agent-1', tool)
      await harness.service.onTurnStopping('agent-1')
      expect(harness.reads(), tool).toBe(1)
      expect(harness.injected, tool).toHaveLength(1)
    }
  })

  it('carries every name the sibling mutating-tool lists carry, since a missing name is the hole', () => {
    // Pinned literally, so extending the set is a visible edit rather than a
    // comment that went stale. The set is a union rather than a derivation on
    // purpose: `plan-mode.ts` and `team/roles.ts` answer narrower questions and
    // are deliberately not equal to each other — `write_file` is refused in Plan
    // Mode but allowed to a team writer — so deriving this list from either one
    // would import a boundary that belongs to that caller.
    expect([...WORKSPACE_MUTATING_TOOLS].sort()).toStrictEqual([
      'apply_patch',
      'create_file',
      'delete_file',
      'edit',
      'edit_and_run',
      'engineering_checkpoint_restore',
      'engineering_hunk_revert',
      'engineering_team_merge',
      'fs_edit',
      'fs_write',
      'move_file',
      'multi_edit',
      'notebook_edit',
      'notebook_write',
      'ralph',
      'send_message',
      'spawn_teammate',
      'str_replace',
      'str_replace_editor',
      'subagent',
      'subagent_claude_code',
      'subagent_codex',
      'subagent_fork',
      'workflow',
      'write',
      'write_file',
    ])
    expect(PLAN_MODE_MUTATING_TOOLS.filter(name => !WORKSPACE_MUTATING_TOOLS.has(name))).toStrictEqual([])
  })

  it('nudges a turn that edited only through multi_edit', async () => {
    // The hole this closes was silent rather than loud: `multi_edit` was absent
    // from the set, so a turn that used nothing else was filed as one that
    // changed nothing, `onTurnStopping` returned before it read anything, and the
    // edit went unverified — the single outcome this gate exists to prevent.
    const harness = gate({ changedPaths: ['src/a.ts'] })
    harness.service.noteToolCall('agent-1', 'multi_edit')
    await harness.service.onTurnStopping('agent-1')
    expect(harness.reads()).toBe(1)
    expect(harness.injected).toHaveLength(1)
  })

  it('nudges a turn that changed the workspace only by delegating', async () => {
    // The multi_edit hole one step out: this turn ran no writer itself, it ran an
    // agent that writes. `subagent` was absent from the set, so the parent was
    // filed as a turn that changed nothing and `onTurnStopping` returned at its
    // first line — the parent's answer then described a tree it had just moved,
    // with no nudge anywhere in the conversation. Every spelling is walked rather
    // than one, because the hole is per-name and this set is a union precisely so
    // that a name cannot be missed by being spelled differently.
    for (const tool of ['subagent', 'subagent_fork', 'workflow', 'ralph', 'spawn_teammate', 'send_message']) {
      const harness = gate({ changedPaths: ['src/a.ts'] })
      harness.service.noteToolCall('agent-1', tool)
      await harness.service.onTurnStopping('agent-1')
      expect(harness.reads(), tool).toBe(1)
      expect(harness.injected, tool).toHaveLength(1)
    }
  })

  it('is satisfied by a verification recorded through recordVerification', async () => {
    // The gate had no reachable satisfied state while nothing in the plugin
    // called `recordEvidence`: this is the path `engineering_team_verify` takes,
    // and a turn that verified must not still be told it established nothing.
    const harness = gate({ changedPaths: ['src/a.ts'] })
    await harness.service.recordVerification('agent-1', 'verified')
    harness.service.noteToolCall('agent-1', 'edit')
    await harness.service.onTurnStopping('agent-1')
    expect(harness.injected).toEqual([])
  })

  it('measures a recorded verification against the paths it read itself', async () => {
    // Recording against a caller-supplied change set would let a verification of
    // yesterday's paths satisfy today's change, which is the one thing the
    // fingerprint exists to prevent.
    const harness = gate({ changedPaths: ['src/a.ts'] })
    await harness.service.recordVerification('agent-1', 'verified')
    expect(harness.reads()).toBe(1)
    harness.service.noteToolCall('agent-1', 'edit')
    await harness.service.onTurnStopping('agent-1')
    expect(harness.injected).toEqual([])
  })

  it('does not let a recorded failure satisfy the gate, and says so', async () => {
    const harness = gate({ changedPaths: ['src/a.ts'] })
    await harness.service.recordVerification('agent-1', 'failed')
    harness.service.noteToolCall('agent-1', 'edit')
    await harness.service.onTurnStopping('agent-1')
    expect(harness.injected).toHaveLength(1)
    expect(harness.injected[0]?.text).toContain('FAILED')
  })

  it('logs a read failure while recording instead of throwing at the caller', async () => {
    const harness = gate({ failing: true })
    await expect(harness.service.recordVerification('agent-1', 'verified')).resolves.toBeUndefined()
    expect(harness.logs.join(' ')).toContain('could not record a verification')
  })
})

describe('verify-on-stop nudge text', () => {
  it('summarizes a long change set instead of listing it all', () => {
    const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts']
    const text = buildVerifyOnStopNudge({ changedPaths: paths, evidence: undefined })
    expect(text).toContain('a.ts, b.ts, c.ts, d.ts, e.ts and 2 more')
    expect(text).not.toContain('g.ts')
  })

  it('names the verification tool together with how to load it', () => {
    // Prompt text that names a deferred tool without the loading sentence is a
    // dead pointer, which is the rule `deferred-tools.ts` exists to enforce.
    const text = buildVerifyOnStopNudge({ changedPaths: ['src/a.ts'], evidence: undefined })
    expect(text).toContain(VERIFICATION_TOOL_NAME)
    // Not just "mentions tool_search": the sentence must carry the exact call
    // that loads *this* tool, or the model has the pointer and no address.
    expect(text).toContain(`select:${VERIFICATION_TOOL_NAME}`)
  })

  it('states the escape hatch rather than insisting', () => {
    const text = buildVerifyOnStopNudge({ changedPaths: ['README.md'], evidence: undefined })
    expect(text).toContain('documentation only')
    expect(text).toContain('say which and continue')
  })

  it('fingerprints a change set independent of order and repetition', () => {
    expect(workspaceFingerprint(['b', 'a'])).toBe(workspaceFingerprint(['a', 'b', 'a']))
    expect(workspaceFingerprint(['a'])).not.toBe(workspaceFingerprint(['a', 'b']))
    expect(workspaceFingerprint(['src\\a.ts'])).toBe(workspaceFingerprint(['src/a.ts']))
  })

  it('still nudges honestly when no evidence was ever recorded', () => {
    const text = buildVerifyOnStopNudge({ changedPaths: ['src/a.ts'], evidence: undefined })
    expect(text).toContain('No verification was recorded')
  })
})
