/**
 * The verify-on-stop gate: a turn that changed the workspace and recorded no
 * verification is told so before it ends.
 *
 * Why
 * ---
 * This plugin owns a real verification runner — declared stages, adversarial
 * probes, and a verdict that refuses to call a run `verified` without one
 * (`engineering-quality.ts`). What it did not own is the *moment*: the runner is
 * reachable through the engineering council path, which needs an approved plan,
 * so an ordinary turn that fixes a bug has no verification step at all and no
 * one is told. Hermes closes this with a stop-time nudge
 * (`agent/verification_stop.py`), and the shape is worth copying exactly: the
 * check is *advisory and specific*, because the alternative — silently ending
 * with a claim nobody tested — is what "green" already means.
 *
 * Three rules keep the nudge from becoming noise, and each is a test:
 *
 * 1. **A turn that changed nothing is never read.** The workspace is inspected
 *    only after a mutating tool actually ran, so a conversation turn costs no
 *    `git` call and cannot produce a nudge.
 * 2. **A nudge is fired once per change set.** The latch is keyed on the
 *    fingerprint of the changed paths, so a model that ignores the nudge is not
 *    told again about the same state — and a *new* change after a nudge is
 *    eligible again, because that is a different fact.
 * 3. **Only a `verified` record with attributable evidence satisfies the gate.**
 *    `unverified` and `failed` do not, and neither does a `verified` record
 *    about a different *state* of the workspace: a verification of yesterday's
 *    change is not evidence about today's. "Different state" is read as content,
 *    not as a path list — see {@link workspaceIdentity} for why the path list
 *    alone let a re-edit of an already-modified file pass as verified.
 *
 * What the nudge deliberately does not do is name a tool that cannot be called.
 * `engineering_team_verify` is the only verification surface this plugin
 * registers, and it requires an approved council plan id, so the nudge states
 * the fact and points at the gate the model can always reach (its own shell)
 * before it mentions the ceremony — and names the deferred tool through
 * `deferredToolFetchHint`, because prompt text that names a deferred tool
 * without saying how to load it is a dead pointer.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/verify-on-stop
 */

import { createHash } from 'node:crypto'
import { deferredToolFetchHint } from './deferred-tools.ts'

/**
 * Tools whose success means the workspace content changed.
 *
 * The set leans long on purpose, and the asymmetry is the whole argument. A
 * name that does not exist is inert: `onTurnStopping` returns before it reads
 * anything when `changedPaths` is empty, so an extra name costs at most one
 * `git` call and can never produce a nudge about a change that did not happen.
 * A missing name is a hole: the turn is filed as one that changed nothing, the
 * nudge never fires, and a real edit goes unverified — the single outcome this
 * module exists to prevent.
 *
 * That is why this is a union rather than a derivation. Two sibling lists
 * answer parts of the same question, `plan-mode.ts`'s
 * `PLAN_MODE_MUTATING_TOOLS` and `team/roles.ts`'s `WRITE_TOOL_NAMES`, and a
 * derivation would import a boundary that belongs to one caller — so this holds
 * their union, plus the plugin's own mutating tools, which neither sibling list
 * knows about. The two siblings were once unequal, over `write_file`: it was
 * absent from the Plan Mode list on the stated grounds that naming it there would
 * fold MCP's `mcp__filesystem__write_file` into a planning session. Both lists
 * compare a whole name, so that fold was never possible, and the absence was a
 * hole in the fence rather than a boundary between callers; `plan-mode.ts` carries
 * the name now. The union shape stays regardless, because the next divergence may
 * be a real one. `verify-on-stop.spec.ts` pins the literal contents and asserts
 * the sibling names are all present, so extending this list is a visible edit
 * rather than a comment that went stale.
 */
export const WORKSPACE_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'edit',
  'write',
  'multi_edit',
  'apply_patch',
  'str_replace',
  'str_replace_editor',
  'create_file',
  'write_file',
  'delete_file',
  'move_file',
  'notebook_edit',
  'notebook_write',
  'fs_write',
  'fs_edit',
  // Plugin tools, which neither sibling list above knows about.
  'edit_and_run',
  // Restoring a checkpoint rewrites files, so it is a mutation like any other.
  'engineering_checkpoint_restore',
  // A revert rewrites the file it undoes — the same edit run backwards, through
  // the plugin rather than through the harness's `edit`. Its success is exactly
  // `hunkWriteText` landing new bytes in a tracked file.
  'engineering_hunk_revert',
  // The one team operation that changes the shared tree, in the words of its own
  // description: it runs a real `git merge --no-ff` at the workspace root, so a
  // turn that only merged still changed tracked files. The other team tools
  // write worktrees under `.freecodego/`, which is gitignored and therefore
  // invisible to the change reader — this one is not.
  'engineering_team_merge',
  // Delegation, for the reason `plan-mode.ts` refuses it: the turn itself ran no
  // writer, but it started an agent that will, and that agent writes *this*
  // workspace. A turn that only delegated was otherwise filed as one that changed
  // nothing, and `onTurnStopping` returned at its first line — so the parent's
  // answer could say "done" about a tree that had moved, with no nudge anywhere.
  // Over-inclusion is free here: a wrong name costs one `readChangedPaths` call
  // that returns empty and ends the read before any nudge is built, which is why
  // the header says the set leans long.
  'subagent',
  'subagent_fork',
  'subagent_codex',
  'subagent_claude_code',
  'workflow',
  'ralph',
  'spawn_teammate',
  'send_message',
])

/** How many changed paths the nudge names before it summarizes the rest. */
const MAX_NAMED_PATHS = 5

/** The verification tool this plugin registers, named once so the text can drift-check it. */
export const VERIFICATION_TOOL_NAME = 'engineering_team_verify'

/** The verdict a verification run reached, as this gate reads it. */
export type VerifyOnStopVerdict = 'verified' | 'unverified' | 'failed'

/** What a verification run recorded, as the gate needs to read it. */
export interface VerifyOnStopEvidence {
  readonly verdict: VerifyOnStopVerdict
  /** Paths that run covered, so a stale record cannot satisfy a new change. */
  readonly changedPaths: readonly string[]
  /**
   * Content digest of the workspace that run measured, when the host could read
   * one.
   *
   * The half a path list cannot supply: two states can hold exactly the same set
   * of modified paths with different bytes in them. Absent means the host could
   * not read one, which leaves the gate with the weaker path claim rather than
   * with a satisfied state.
   */
  readonly revision?: string
}

/** Collaborators, all injected so the gate is testable without a session. */
export interface VerifyOnStopHost {
  /** Whether the gate is enabled; the caller owns the settings switch. */
  readonly enabled: () => boolean
  /**
   * Paths the workspace has changed, as the caller can read them.
   *
   * Keyed by agent because the workspace is a property of the session: two
   * agents in one process have different `cwd`s, and a gate that read one
   * workspace for both would nudge about a change the agent never made.
   */
  readonly readChangedPaths: (agentId: string) => Promise<readonly string[]>
  /**
   * A digest of the workspace's *content*, not of which paths changed.
   *
   * Read through the host like {@link VerifyOnStopHost.readChangedPaths}, and for
   * the same reason: a record and the check that consumes it must be measured
   * against one workspace, by construction. `undefined` when the host cannot
   * answer — no repository, a read that did not finish — which is not the same
   * fact as "unchanged" and never a match.
   */
  readonly readChangeRevision: (agentId: string) => Promise<string | undefined>
  /** Deliver the nudge to the agent. */
  readonly inject: (agentId: string, text: string) => void
  /** Diagnostics; the gate never throws into the turn it is observing. */
  readonly log: (message: string) => void
}

/** A stable identity for a set of changed paths, independent of order. */
export function workspaceFingerprint(paths: readonly string[]): string {
  const normalized = [...new Set(paths.map(path => path.replace(/\\/gu, '/').trim()).filter(path => path !== ''))].sort()
  return createHash('sha256').update(normalized.join('\n')).digest('hex').slice(0, 16)
}

/**
 * The identity of one workspace state: content when it can be read, paths when
 * it cannot.
 *
 * A path list is not an identity. Re-editing a file that was already modified
 * changes no path and no status letter, so a record of `['src/a.ts']` satisfied
 * the gate for the *next* edit of `src/a.ts` — the same failure the rule about
 * yesterday's change exists to prevent, arriving inside one session instead of
 * across two days. The content digest is prefixed so it can never be mistaken
 * for a path fingerprint, and a host that cannot read one (a workspace with no
 * repository behind it) leaves the gate with the weaker claim it has always
 * made rather than with no claim at all.
 *
 * Which is also why an identity built from paths never matches one built from
 * content: a verification recorded without a revision cannot be shown to cover a
 * workspace that now has one, and "cannot be shown" is not "covered".
 *
 * @param changedPaths - paths the change reader reported.
 * @param revision - the content digest, when the host could read one.
 * @returns the identity the gate compares and remembers.
 */
function workspaceIdentity(changedPaths: readonly string[], revision: string | undefined): string {
  return revision === undefined ? workspaceFingerprint(changedPaths) : `rev:${revision}`
}

/**
 * Build the nudge text.
 *
 * Stated as what is true rather than as an instruction to feel bad: the model is
 * told which files changed, that no verification of them was recorded, and the
 * two ways to establish one. The escape hatch is explicit, because a change that
 * genuinely needs no verification (prose, a comment) must not be argued with —
 * the gate exists to make an omission visible, not to insist.
 *
 * @param input - the changed paths and whatever verification was recorded.
 * @returns the message to deliver.
 */
export function buildVerifyOnStopNudge(input: {
  readonly changedPaths: readonly string[]
  readonly evidence: VerifyOnStopEvidence | undefined
}): string {
  const named = input.changedPaths.slice(0, MAX_NAMED_PATHS)
  const rest = input.changedPaths.length - named.length
  const list = rest > 0 ? `${named.join(', ')} and ${rest} more` : named.join(', ')
  const recorded = input.evidence === undefined
    ? 'No verification was recorded for this turn.'
    : input.evidence.verdict === 'verified'
      // One sentence for three reasons — other paths, other content, or a
      // workspace the host could not measure — because all three mean the same
      // thing to the reader: that check did not cover what is here now.
      ? 'A verification was recorded, but not for the workspace as it stands now.'
      : `The last verification of this work came back ${input.evidence.verdict.toUpperCase()}.`
  return [
    `This turn changed the workspace (${list}) but established nothing about the change. ${recorded}`,
    'A green build is not a verification: the project gate says the workspace still compiles, not that the new behaviour is right.',
    'Run the check that covers these files now, through your shell tool, and read its exit status. A command whose last stage is `true`, `echo`, or a pipe into `tail` reports that stage\'s status, not the check\'s.',
    `When the change came from an approved council plan, \`${VERIFICATION_TOOL_NAME}\` runs the declared stages plus the adversarial probes you declare there, and a run with no probe is UNVERIFIED.${deferredToolFetchHint(VERIFICATION_TOOL_NAME)}`,
    'If the change is documentation only, or you verified it another way, say which and continue — the point is that the omission be visible, not that you run something.',
  ].join('\n')
}

/**
 * The stop-time gate.
 *
 * One instance serves every agent; state is keyed by agent id and retired when
 * the caller says the agent is gone, because an entry that outlives its agent
 * would suppress the nudge for the next agent that reuses the id.
 */
export class FreeCodeGoVerifyOnStop {
  /** Agents that mutated the workspace during the turn now ending. */
  private readonly mutated = new Set<string>()
  /** The change set each agent was last nudged about, so one nudge is enough. */
  private readonly nudgedAt = new Map<string, string>()
  /** The last verification each agent recorded. */
  private readonly evidence = new Map<string, VerifyOnStopEvidence>()

  constructor(private readonly host: VerifyOnStopHost) {}

  /** Whether this tool call is one whose success changes workspace content. */
  noteToolCall(agentId: string, toolName: string): void {
    if (WORKSPACE_MUTATING_TOOLS.has(toolName)) this.mutated.add(agentId)
  }

  /**
   * Record a verification run.
   *
   * Only the caller knows whether the run's probes were attributable; this gate
   * trusts the verdict it is handed, which is why `engineering-quality.ts`
   * refuses `verified` without one (`verification-evidence.ts`).
   */
  recordEvidence(agentId: string, evidence: VerifyOnStopEvidence): void {
    this.evidence.set(agentId, evidence)
  }

  /**
   * Record a verification run's verdict for an agent.
   *
   * The paths are read through the same host reader the stop-time check uses, so
   * a record and the check that consumes it are measured against one change set
   * by construction — that is what makes "a verification of yesterday's change
   * is not evidence about today's" hold without a second notion of the workspace.
   *
   * `recordEvidence` alone is not enough to be reachable: a verdict with no paths
   * attached would satisfy the gate for whatever change happened next, so every
   * recording goes through here.
   *
   * Never throws: the gate observes a turn, and a verification that already
   * succeeded must not be turned into a failure by failing to file it.
   *
   * @param agentId - the agent whose verification ran.
   * @param verdict - what that run concluded.
   */
  async recordVerification(agentId: string, verdict: VerifyOnStopVerdict): Promise<void> {
    try {
      const changedPaths = await this.host.readChangedPaths(agentId)
      // A revision the host cannot read is not a reason to lose the record: the
      // paths still say which change was verified, and the gate falls back to
      // that weaker identity on both sides of the comparison.
      const revision = await this.host.readChangeRevision(agentId).catch(() => undefined)
      this.recordEvidence(agentId, { verdict, changedPaths, ...(revision === undefined ? {} : { revision }) })
    } catch (error: unknown) {
      this.host.log(`freecodego: verify-on-stop could not record a verification: ${String(error)}`)
    }
  }

  /** Retire every entry for an agent; called when the agent is disposed. */
  forget(agentId: string): void {
    this.mutated.delete(agentId)
    this.nudgedAt.delete(agentId)
    this.evidence.delete(agentId)
  }

  /**
   * Observe a turn that is stopping.
   *
   * Never throws: a gate that can fail a turn is worse than the omission it
   * reports, so every failure is logged and the turn proceeds.
   *
   * @param agentId - the agent whose turn is ending.
   */
  async onTurnStopping(agentId: string): Promise<void> {
    const mutated = this.mutated.delete(agentId)
    if (! mutated) return
    try {
      if (! this.host.enabled()) return
      const changedPaths = await this.host.readChangedPaths(agentId)
      if (changedPaths.length === 0) return
      const revision = await this.host.readChangeRevision(agentId).catch(() => undefined)
      const identity = workspaceIdentity(changedPaths, revision)
      const evidence = this.evidence.get(agentId)
      if (evidence?.verdict === 'verified' && workspaceIdentity(evidence.changedPaths, evidence.revision) === identity) {
        this.nudgedAt.delete(agentId)
        return
      }
      // The latch is keyed by the same identity, and for the same reason: a
      // second edit of an already-modified file is a different fact, so the
      // nudge for it must not be suppressed as a repetition of the first.
      if (this.nudgedAt.get(agentId) === identity) return
      this.nudgedAt.set(agentId, identity)
      this.host.inject(agentId, buildVerifyOnStopNudge({ changedPaths, evidence }))
    } catch (error: unknown) {
      this.host.log(`freecodego: verify-on-stop could not read the workspace: ${String(error)}`)
    }
  }
}
