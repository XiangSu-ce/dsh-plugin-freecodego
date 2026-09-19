/**
 * Roles as data: purpose, capabilities, tool scope, and a report contract.
 *
 * The council already separates *engines* — three vendors reviewing one plan.
 * A role separates *duties* inside one effort, which is a different axis and the
 * one that keeps a writer from grading its own homework. Claude Code encodes it
 * per agent (`tools`, `disallowedTools`, `maxTurns`, `permissionMode`) and writes
 * down for each role what it is explicitly **not** responsible for; the
 * open-source multi-agent plugins ship nineteen such role definitions as data.
 *
 * So roles live here as plain records rather than as branches in the runtime:
 * a project can add or tighten a role in `.freecodego/team-roles.json` without
 * touching this plugin, and every role states its own boundary.
 *
 * Two invariants are enforced rather than documented:
 *
 * - A role that cannot write cannot be handed write tools, whatever its
 *   `toolAllow` says, because the allow list is intersected with the capability
 *   set on the way out ({@link resolveRoleTools}).
 * - `explorer` and `verifier` are read-only by construction, so the independent
 *   check cannot become a second implementer.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/team/roles
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deferredToolFetchHint } from '../deferred-tools.ts'
import { boundedTeamText } from './state.ts'

/** What a role is permitted to do, at the level of intent rather than tool name. */
export type TeamCapability = 'read' | 'write' | 'execute' | 'delegate'

export interface TeamRoleDefinition {
  readonly id: string
  readonly title: string
  /** One line a reader can use to decide whether this role fits. */
  readonly purpose: string
  /** What this role must not do. Every built-in role states one. */
  readonly notResponsibleFor: string
  readonly capabilities: readonly TeamCapability[]
  /** Tool names this role may use; empty means "everything its capabilities allow". */
  readonly toolAllow: readonly string[]
  /** Tool names removed even when the capability set would allow them. */
  readonly toolDeny: readonly string[]
  /** `inherit` keeps the parent's model, which keeps the prompt cache warm. */
  readonly model: string
  readonly maxTurns: number
  readonly sandbox: 'read-only' | 'workspace-write'
  /** Sections the member must include in its final report: the bounded contract. */
  readonly reports: readonly string[]
}

/**
 * Tool names only a writer may hold.
 *
 * Curated rather than discovered, and that direction is the whole risk: a name
 * the harness never offers is inert, while a name this list is missing is a
 * read-only role holding a tool that deletes a file. It was missing six —
 * `notebook_write`, `str_replace_editor`, `delete_file`, `move_file`, `fs_write`
 * and `fs_edit` — which `team-roles-context.spec.ts` now pins by name, because
 * the fixture it used before only ever offered `write` and `edit`.
 *
 * Kept separate from `PLAN_MODE_MUTATING_TOOLS` in `plan-mode.ts` rather than
 * derived from it, because the two answer different questions and a derivation
 * would import a boundary that belongs to one caller. They are equal today, and
 * that is a reading rather than a rule: this list says what only a writer may
 * hold, that one says what a frozen workspace refuses.
 *
 * The one name they used to disagree on was `write_file`, which this list carried
 * and that one did not — justified there as "so an MCP server's own
 * `mcp__filesystem__write_file` is not swept up by a planning session". No such
 * sweep exists to avoid: both lists compare a whole name (`^(?:…)$` here,
 * `Array.prototype.includes` there), so a prefixed name was never reachable from a
 * bare entry. The difference was therefore not a tradeoff between two callers but
 * a hole in the fence — a writing tool name callable while planning — and
 * `plan-mode.ts` carries it now.
 */
/**
 * Tool names this plugin registers that change files in the workspace.
 *
 * The same direction as the harness list above, one tier in, and it was missing
 * for the same reason that list was missing six: `resolveRoleTools` decides by
 * name, so a name in neither list is a read-only role holding a writer. These
 * four write through this plugin's own code path rather than through the
 * harness's `edit`/`write`, which is what makes the gap worse than a harness
 * name would be — the read-only sandbox is a harness policy the harness's tools
 * consult, while `engineering_hunk_revert` lands bytes through `hunkWriteText`
 * and `engineering_team_merge` runs a real `git merge` at the workspace root.
 *
 * A read-only role is also the one role that is **not** isolated: `team/tools.ts`
 * gives a worktree to a writing role, so an unisolated writer edits the tree it
 * was started to observe. A verifier handed this list can undo the very change it
 * is supposed to falsify, and its brief saying it must not is a sentence, not a
 * restriction.
 */
const PLUGIN_WRITE_TOOL_NAMES = [
  // Edits a file and runs the command that proves the edit landed.
  'edit_and_run',
  // Restoring a checkpoint rewrites the files it captured.
  'engineering_checkpoint_restore',
  // A revert lands new bytes in the file it undoes — the same edit run backwards.
  'engineering_hunk_revert',
  // The one team tool that changes the shared tree, and the reason the integrator
  // role carries `write`.
  'engineering_team_merge',
]

const WRITE_TOOL_NAMES = [
  'write', 'edit', 'multi_edit', 'apply_patch', 'notebook_edit', 'notebook_write',
  'str_replace', 'str_replace_editor', 'write_file', 'create_file', 'delete_file',
  'move_file', 'fs_write', 'fs_edit',
  ...PLUGIN_WRITE_TOOL_NAMES,
]
// Built from the list rather than written as one literal: fourteen names do not
// fit the `max-len` budget on a single line, and a regex the linter wants
// reflowed is a regex somebody reflows by hand.
const WRITE_TOOL_PATTERN = new RegExp(`^(?:${WRITE_TOOL_NAMES.join('|')})$`, 'u')

/** Tool names that mutate the machine beyond the workspace. */
const EXECUTE_TOOL_PATTERN = /^(bash|shell|powershell|pwsh|run_terminal_command|run_command|terminal|exec)$/u

/**
 * Tool names that start or wake another Agent.
 *
 * The fourth capability in the vocabulary, and until now the only one nothing
 * read: `resolveRoleTools` gated `write` and `execute`, while `delegate` was
 * declared, set on the architect, and consulted by no rule. The only delegation
 * fence was therefore the explorer's hand-written `toolDeny`, which names three
 * of the plugin's four spellings and misses `engineering_subagent_start`, and
 * knows none of the harness's (`subagent`, `workflow`, `ralph`, `spawn_teammate`,
 * `send_message`) — the same hand-list shape this file already warns about one
 * paragraph up, arrived at from the other end.
 *
 * A rule rather than a longer list, for the reason `plan-mode.ts` gives for
 * refusing delegation: a conversation that can hand its calls to a child has a
 * fence made of a naming convention, and the child writes the same workspace.
 * Nothing is lost by withholding these: a member is told to reach its peers
 * through the parent (`roleInstructions`), and the architect — the one role whose
 * job is to lay work out — keeps the capability.
 */
const DELEGATE_TOOL_PATTERN = /^(?:subagent|subagent_fork|subagent_codex|subagent_claude_code|workflow|ralph|spawn_teammate|send_message|engineering_subagent_start|engineering_team_start|engineering_team_member_start|engineering_council_review)$/u

export const BUILT_IN_TEAM_ROLES: readonly TeamRoleDefinition[] = [
  {
    id: 'explorer',
    title: 'Explorer',
    purpose: 'Map the relevant code and report a bounded, evidence-linked picture before anyone edits anything.',
    notResponsibleFor: 'It does not plan the change, does not implement it, and does not recommend an approach.',
    capabilities: ['read'],
    toolAllow: [],
    toolDeny: ['engineering_team_start', 'engineering_team_member_start', 'engineering_council_review'],
    model: 'inherit',
    maxTurns: 6,
    sandbox: 'read-only',
    reports: ['findings', 'evidence', 'uncertainty'],
  },
  {
    id: 'architect',
    title: 'Architect',
    purpose: 'Turn an objective into an ordered, dependency-aware task list and name the interfaces it assumes.',
    notResponsibleFor: 'It does not implement the plan, and it does not verify the result.',
    capabilities: ['read', 'write', 'delegate'],
    toolAllow: [],
    toolDeny: [],
    model: 'inherit',
    maxTurns: 12,
    sandbox: 'workspace-write',
    reports: ['plan', 'interfaces', 'risks'],
  },
  {
    id: 'implementer',
    title: 'Implementer',
    purpose: 'Complete one claimed task in its own worktree, and stop when the task is done.',
    notResponsibleFor: 'It does not claim further tasks, does not merge its own work, and does not declare itself verified.',
    capabilities: ['read', 'write', 'execute'],
    toolAllow: [],
    toolDeny: ['engineering_team_verify', 'engineering_team_mark_implemented'],
    model: 'inherit',
    maxTurns: 30,
    sandbox: 'workspace-write',
    reports: ['task', 'files', 'commands', 'uncertainty'],
  },
  {
    id: 'verifier',
    title: 'Verifier',
    purpose: 'Falsify another member\u2019s change with declared probes and report what held and what did not.',
    notResponsibleFor: 'It does not edit the code it verifies, and its findings never authorize a merge by themselves.',
    capabilities: ['read', 'execute'],
    toolAllow: [],
    toolDeny: ['engineering_team_mark_implemented'],
    model: 'inherit',
    maxTurns: 12,
    sandbox: 'read-only',
    reports: ['probes', 'observed', 'verdict', 'unmet'],
  },
  {
    id: 'integrator',
    title: 'Integrator',
    purpose: 'Merge finished, verifier-backed worktrees in dependency order and route conflicts to their owners.',
    notResponsibleFor: 'It does not change behaviour to make a merge succeed, and it does not merge unverified work.',
    capabilities: ['read', 'write', 'execute'],
    toolAllow: [],
    toolDeny: [],
    model: 'inherit',
    maxTurns: 20,
    sandbox: 'workspace-write',
    reports: ['merged', 'conflicts', 'routed'],
  },
]

const CAPABILITIES: readonly TeamCapability[] = ['read', 'write', 'execute', 'delegate']

/**
 * Read project-defined roles from `.freecodego/team-roles.json`.
 *
 * Invalid entries are dropped rather than thrown on, and a same-id entry
 * replaces its built-in: tightening a role is the common case (a project that
 * does not want the implementer running shell commands), and a loader that
 * refused a partial override would push that into this plugin's source.
 */
export async function loadProjectTeamRoles(cwd: string): Promise<readonly TeamRoleDefinition[]> {
  let raw: string
  try {
    raw = await readFile(join(cwd, '.freecodego', 'team-roles.json'), 'utf8')
  } catch {
    return []
  }
  try {
    return parseTeamRoles(JSON.parse(raw))
  } catch {
    return []
  }
}

export function parseTeamRoles(input: unknown): readonly TeamRoleDefinition[] {
  const entries = Array.isArray(input) ? input : input !== null && typeof input === 'object' ? (input as { roles?: unknown }).roles : undefined
  if (!Array.isArray(entries)) return []
  const roles: TeamRoleDefinition[] = []
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const candidate = entry as Partial<TeamRoleDefinition>
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
    if (id === '') continue
    const capabilities = Array.isArray(candidate.capabilities)
      ? candidate.capabilities.filter((value): value is TeamCapability => CAPABILITIES.includes(value as TeamCapability))
      : []
    const strings = (value: unknown, limit: number): readonly string[] => Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => item.trim()).slice(0, limit)
      : []
    roles.push({
      id,
      title: boundedTeamText(candidate.title, 80) || id,
      purpose: boundedTeamText(candidate.purpose, 500),
      notResponsibleFor: boundedTeamText(candidate.notResponsibleFor, 500),
      capabilities: capabilities.length > 0 ? capabilities : ['read'],
      toolAllow: strings(candidate.toolAllow, 200),
      toolDeny: strings(candidate.toolDeny, 200),
      model: boundedTeamText(candidate.model, 120) || 'inherit',
      maxTurns: typeof candidate.maxTurns === 'number' && Number.isFinite(candidate.maxTurns) ? Math.min(60, Math.max(1, Math.trunc(candidate.maxTurns))) : 12,
      sandbox: candidate.sandbox === 'workspace-write' && capabilities.includes('write') ? 'workspace-write' : 'read-only',
      reports: strings(candidate.reports, 12).length > 0 ? strings(candidate.reports, 12) : ['findings'],
    })
  }
  return roles
}

/** Project roles override built-ins of the same id. */
export function mergeTeamRoles(overrides: readonly TeamRoleDefinition[]): readonly TeamRoleDefinition[] {
  const byId = new Map(BUILT_IN_TEAM_ROLES.map(role => [role.id, role]))
  for (const role of overrides) byId.set(role.id, role)
  return [...byId.values()]
}

export function teamRoleById(roles: readonly TeamRoleDefinition[], id: string): TeamRoleDefinition | undefined {
  return roles.find(role => role.id === id)
}

/**
 * The tools a member in this role may actually hold.
 *
 * The allow list is *intersected* with what the role's capabilities permit: a
 * role without `write` cannot be given a write tool by naming it, so a project
 * file cannot turn the explorer into an implementer by accident. `toolDeny`
 * removes from that result, and capabilities are checked by pattern rather than
 * by a hand-maintained list, so a newly registered write tool is covered the day
 * it appears — provided the name is in the pattern's list, which is the half this
 * file has had to extend twice (`multi_edit` and friends for the harness's
 * spellings, and `PLUGIN_WRITE_TOOL_NAMES` for this plugin's own).
 *
 * Three of the four declared capabilities are read here. `delegate` gates the
 * tool names that start or wake another Agent, and it is checked like the other
 * two rather than left as a description of intent: a member that can start a
 * writer is a writer one call removed.
 */
export function resolveRoleTools(role: TeamRoleDefinition, available: readonly string[]): readonly string[] {
  const canWrite = role.capabilities.includes('write')
  const canExecute = role.capabilities.includes('execute')
  const canDelegate = role.capabilities.includes('delegate')
  const denied = new Set(role.toolDeny)
  return available.filter((name) => {
    if (denied.has(name)) return false
    if (!canWrite && WRITE_TOOL_PATTERN.test(name)) return false
    if (!canExecute && EXECUTE_TOOL_PATTERN.test(name)) return false
    if (!canDelegate && DELEGATE_TOOL_PATTERN.test(name)) return false
    if (role.toolAllow.length > 0 && !role.toolAllow.includes(name)) return false
    return true
  })
}

/**
 * The contract appended to a member's instructions.
 *
 * A member that is told which sections to report produces a summary the parent
 * can read without opening its transcript, and the "not responsible for" line is
 * what keeps a verifier from drifting into editing. Both come from the role
 * record, so adding a role does not mean adding a prompt branch.
 *
 * A claimed task comes with its claim token. Closing a claimed task requires
 * presenting that token, so a brief that names the task but withholds the token
 * would hand the member work it is structurally unable to finish — it would
 * either stall or ask the parent to close work on its behalf.
 *
 * The same reasoning covers the schema: every team tool matches the deferred
 * prefix rule, so the member does not have `engineering_team_task_update` in
 * front of it until something fetches it, and the brief is unsolicited text
 * with no discovery flow around it. The member is therefore told both the call
 * and how to load it, from the shared hint rather than from a sentence restated
 * here.
 */
export function roleInstructions(role: TeamRoleDefinition, input: { readonly task?: { readonly id: string; readonly title: string; readonly detail: string; readonly claimToken?: string | undefined }; readonly teammates?: readonly string[] } = {}): string {
  const lines = [
    `You are the ${role.title} on a team: ${role.purpose}`,
    `You are NOT responsible for: ${role.notResponsibleFor}`,
  ]
  if (input.task !== undefined) {
    lines.push(`Current task ${input.task.id}: ${input.task.title}${input.task.detail === '' ? '' : `\n${input.task.detail}`}`)
    if (input.task.claimToken !== undefined) {
      lines.push(`Close this task with engineering_team_task_update (action "complete") and pass claim_token ${input.task.claimToken}. Without that token the board refuses to close it, because a token is how the board knows you are still the member holding this work.`)
      const fetchHint = deferredToolFetchHint('engineering_team_task_update')
      if (fetchHint !== '') lines.push(fetchHint)
    }
  }
  if (input.teammates !== undefined && input.teammates.length > 0) lines.push(`Other members on this team: ${input.teammates.join(', ')}. Reach them through the parent; members do not talk to each other directly.`)
  lines.push(`Report exactly these sections: ${role.reports.join(', ')}. Keep each to a few lines; the parent reads your summary, not your transcript.`)
  return lines.join('\n\n')
}
