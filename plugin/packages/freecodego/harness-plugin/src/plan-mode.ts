/**
 * Plan Mode: a conversation mode that structurally cannot mutate the workspace.
 *
 * Why
 * ---
 * Codex's `collaboration-mode-templates/plan.md` states the two properties that
 * make a plan mode worth having, and both are easy to get wrong:
 *
 * 1. **The boundary is on mutation, not on tool names.** Reading, searching,
 *    static analysis and dry runs are *allowed*, because they are how you make a
 *    plan good. Tests and builds that write caches or build output are allowed
 *    too; editing a repo-tracked file is not. The test the wording uses is worth
 *    keeping verbatim: *"if the action would reasonably be described as doing the
 *    work rather than planning the work, do not do it."*
 * 2. **The mode does not move because of user tone.** "Plan Mode is not changed
 *    by user intent, tone, or imperative language. If a user asks for execution
 *    while still in Plan Mode, treat it as a request to *plan* the execution."
 *    A mode that a firm sentence can end is not a mode; it is a suggestion. So the
 *    state is durable, exits only through an explicit command, and the refusal
 *    the model receives says exactly that.
 *
 * Where the enforcement lives
 * ---------------------------
 * Not in the prompt. The injected guidance makes the model cooperate, but the
 * refusal is enforced the same way `deferred-tools.ts` enforces visibility: the
 * denied names come from one list, so "the model was told" and "the model can do
 * it" cannot drift. A mutating call in Plan Mode fails with a message naming the
 * mode and the exit action.
 *
 * **The classification is exhaustive and fails closed.** The criterion for
 * `mutating` is the one the guidance states: it writes repo-tracked files, or it
 * runs another Agent that will. `engineering_checkpoint_restore` rewrites tracked
 * files and deletes the ones created since the snapshot; `engineering_hunk_revert`
 * puts one hunk back; and `engineering_worktree_enter` cuts a branch. A plugin tool this module has
 * never classified is **refused**, not assumed harmless: the previous default
 * (anything not on a hand-written denylist is allowed) meant every newly added
 * mutating tool silently became callable in Plan Mode, which is the one direction
 * a mode marketed as structural cannot afford. `plan-mode`'s own spec enumerates
 * every tool the plugin registers from source, so a new one fails that test until
 * it is classified here.
 *
 * Shell commands are the interesting case. A blanket `bash` denial would block
 * the exploration the mode depends on, so `bash` is evaluated by the same
 * declarative policy the guard uses, and anything the policy would *prompt* or
 * *forbid* is refused with the rule's own justification. That keeps one source of
 * truth for what a dangerous command is.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/plan-mode
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { evaluateCommandPolicy, type CompiledCommandPolicy } from './command-policy.ts'
import { freeCodeGoDataHome } from './data-home.ts'
import { pluginToolsWithPlanMode, pluginToolsWithoutPrefix } from './tool-manifest.ts'

/** Whether a conversation only gathers truth or may change the workspace. */
export type PlanMode = 'execute' | 'plan'

/**
 * Non-plugin tools that change repo-tracked files, in the harness's naming.
 *
 * The harness owns these names, so they are curated here rather than discovered:
 * a name that does not exist is inert, while a missing name is a hole.
 *
 * `write_file` was that hole, and it was left by a comment rather than by
 * oversight. A sibling module states in prose that this list refuses it —
 * `verify-on-stop.ts`, in its own set's header — and the reason it gives for the
 * omission is that naming it here would fold an MCP server's
 * `mcp__filesystem__write_file` into a planning session. That reason describes a
 * mechanism this fence does not have: the test below is
 * `PLAN_MODE_MUTATING_TOOLS.includes(tool)`, an exact comparison, so a bare
 * `write_file` entry can never match a prefixed name. The omission therefore
 * bought nothing and cost the one thing the header calls a hole — a name the
 * rest of this codebase treats as a writer (`WORKSPACE_MUTATING_TOOLS` carries
 * it, and `hunk-glue.spec.ts` uses it as *the* representative write tool) being
 * callable while the workspace is supposed to be frozen.
 *
 * `edit_file` is the sibling spelling in the same alias family and is
 * deliberately **not** added: no sibling list treats it as a writer, so naming it
 * would be a guess rather than a reading, and the hook family that carries it
 * carries it as a matcher alias.
 *
 * Delegation is the half of the criterion that was missing. The rule stated
 * above — "it writes repo-tracked files, **or it runs another Agent that will**"
 * — was applied only to this plugin's own spawn tool
 * (`engineering_subagent_start`, in the list below), so the Harness's own
 * spellings were callable while the workspace was frozen: a fenced conversation
 * could not call `write`, but it could call `subagent` and let the child call it.
 *
 * The fence was left resting on the child inheriting its parent's mode instead,
 * and that is not a mechanism this deployment has. `modeFor` asks upstream plan
 * mode first; upstream answers from the *calling* agent's own `plan` projection;
 * and a child's projection carries `plan/mode` only when the child was seeded
 * from the parent's log. The `fork` provider does seed it
 * (`subagent-fork-in-process`: "a forked child IS seeded with the parent's
 * completed-turn prefix"), the `spawn` provider deliberately does not
 * (`subagent-spawn-in-process`: "Fresh child: no seed"), and this deployment's
 * preset mounts `workflow` and `ralph` on `spawn` — so their children were never
 * fenced at all. Even a `fork` child escapes when the mode was committed inside
 * the current turn, because that `plan/mode` lands after the last `turn/end` and
 * the seed stops there. The `PlanModeStore` that `persona/resolve.ts` cites as
 * the reason children are judged by their parent's mode is unreachable in this
 * composition: `modeFor` returns upstream's answer before it, and
 * `applyPlanMode` returns before writing it.
 *
 * So the delegation is refused here, which is what this module already does for
 * its own spawn tool and for the reason stated there: a fenced parent that can
 * hand its calls to a child has a fence made of a naming convention.
 *
 * The names are the ones this deployment can actually register, read off the
 * preset (`assets/presets/*\/agent.cordis.yml`) and the tool packages rather
 * than guessed — `subagent` is also `tool-subagent`'s default, so a preset row
 * that omits `toolName` still registers it. `send_message` is included although
 * it starts nothing by itself: it wakes an inactive teammate, which is how a
 * dormant writer's turn begins.
 */
export const PLAN_MODE_MUTATING_TOOLS: readonly string[] = [
  'write',
  'edit',
  'multi_edit',
  'apply_patch',
  'create_file',
  'write_file',
  'notebook_edit',
  'notebook_write',
  'str_replace',
  'str_replace_editor',
  'delete_file',
  'move_file',
  'fs_write',
  'fs_edit',
  // Every `@deepseek-ai/dsh-tool-subagent` spelling the presets register.
  'subagent',
  'subagent_fork',
  'subagent_codex',
  'subagent_claude_code',
  // Fan-out runners, mounted on the `spawn` provider.
  'workflow',
  'ralph',
  // The Harness's team tools that start a member's turn.
  'spawn_teammate',
  'send_message',
]

/**
 * Prefixes that identify a tool this plugin registered.
 *
 * These prefixes, plus this plugin's own unprefixed names, are also the whole
 * reach of the unclassified-tool rule below. An upstream capability — the five
 * `session_*` query tools, a browser provider's tool names, a desktop driver's —
 * is therefore neither refused nor permitted *by this mode*: the branch does not
 * reach it. That is the same shape as the third-party MCP writer the spec records
 * as a known gap, and it is deliberate. A browser and a desktop are not the
 * workspace this mode freezes; a session-history read is the mode's own business
 * to allow, and a list of names here could only be a guess, because a browser
 * provider registers the tool names of the MCP server it drives and this
 * repository cannot read that server's list. All three rows this bundle mounts
 * (`bundle-latest/cordis.patch.yml`) ship `disabled`, so a deployment turns one on
 * before this becomes its question. `tests/plan-mode.spec.ts` pins the boundary,
 * and reads the query tool names from the package that registers them.
 */
export const PLAN_MODE_PLUGIN_TOOL_PREFIXES: readonly string[] = ['engineering_', 'advisor_', 'agnes_', 'freecodego_', 'headroom_']

/**
 * Plugin tools Plan Mode refuses, read off the manifest's `planMode` column.
 *
 * The names and the reasons for them are rows in `tool-manifest.ts`, because
 * this list's own history is a record of entries that arrived late. It was
 * missing `engineering_checkpoint_restore` (which rolls the whole workspace back
 * to a snapshot), `engineering_hunk_revert`, `engineering_team_verify`, and the
 * two worktree names — and each one was
 * refused only because *unclassified* tools are refused, which is a decision no
 * reader of this file could see. A tool with no row is now a failing test rather
 * than a name that fell through every branch.
 */
export const PLAN_MODE_MUTATING_PLUGIN_TOOLS: readonly string[] = pluginToolsWithPlanMode('refuse')

/**
 * Plugin tools registered **without** a plugin prefix, derived from the manifest.
 *
 * The fence's other branch reaches a tool by prefix, so a name with no prefix is
 * invisible to it — and invisible means unreached, not refused. That was worth
 * spelling out when the four readers this list names were callable while planning
 * only because nothing looked at them. It is worth *deriving* now, because which
 * names carry a prefix is a fact about the registration rather than a decision
 * about the mode, and a derivation cannot fall behind a tool added tomorrow.
 * `tests/tool-manifest.spec.ts` is what keeps the manifest itself complete: every
 * registration literal in this package has a row there, prefixed or not.
 */
export const PLAN_MODE_UNPREFIXED_PLUGIN_TOOLS: readonly string[] = pluginToolsWithoutPrefix(PLAN_MODE_PLUGIN_TOOL_PREFIXES)

/**
 * Plugin tools that stay usable in Plan Mode, read off the manifest.
 *
 * The `planMode` column of `tool-manifest.ts` is the list; the manifest's own
 * header is where each decision is argued, row by row, including the rows that
 * keep a real authority — `engineering_council_review` and
 * `engineering_team_start` start child Agents, read-only ones — because a reason
 * written once beside the name is a reason a reader can disagree with.
 *
 * Kept as a positive list rather than "everything not denied", because that
 * default is what let a newly added mutating tool become callable silently.
 * `tests/tool-manifest.spec.ts` is what gives the list its force: it reads the
 * registration literals out of this package's source and requires each one to be
 * a row, so an unclassified tool is a failing test rather than a name that drifts
 * past all three lists.
 *
 * `tool_search` is deliberately absent. It was named here while this was a
 * hand-written list, and the entry was inert for the same reason it was harmless:
 * the fence only reaches that branch for a name it recognises as this plugin's
 * own, and `tool_search` is a Harness tool this package never registers. Naming
 * a tool this plugin does not own inside its own manifest would be the same
 * category error the single table exists to prevent.
 */
export const PLAN_MODE_ALLOWED_PLUGIN_TOOLS: readonly string[] = pluginToolsWithPlanMode('allow')

/** The mode rules the model reads while Plan Mode is on. */
export const PLAN_MODE_GUIDANCE = [
  'You are in PLAN MODE. It ends only when the user says so, as a sentence of its own.',
  'User intent, tone, or an imperative sentence does not end Plan Mode. If the user asks for execution, plan the execution.',
  '',
  'Allowed: reading, searching, static analysis, dry runs, tests and builds that only write caches or build output.',
  'Not allowed: editing or creating repo-tracked files, running formatters that rewrite files, applying patches or migrations, or any command whose purpose is to carry out the plan rather than refine it.',
  'When in doubt, ask: would this be described as doing the work, or as planning the work? If it is doing, do not do it.',
  '',
  'Explore before asking. Resolve from the repository anything the repository can answer, and only then ask the user.',
  'A plan is finished when it is decision complete: the implementer should not have to make any decision you could have made.',
].join('\n')

/**
 * The half of the rules only this plugin can state: that Plan Mode here is
 * *enforced* by refusing calls, and that a plugin tool it has not classified is
 * refused rather than assumed harmless.
 *
 * Why this is a separate constant: the Harness owns Plan Mode. Its own
 * `plan:policy` section already tells the model to plan rather than execute,
 * and it is the section a deployment configures. Restating that half injects a
 * second, longer copy of the same instruction on every request of every plan
 * turn, and the two wordings can drift. What upstream cannot say is what this
 * plugin does about it, so when upstream is composed only this addendum is
 * injected. {@link PLAN_MODE_GUIDANCE} remains the standalone text for a
 * composition that mounted no upstream plan mode at all, where these rules are
 * the model's only source of the mode.
 */
export const PLAN_MODE_ENFORCEMENT_ADDENDUM = [
  'In this deployment Plan Mode is enforced, not merely requested: a tool call that changes the workspace is refused, and so is a shell command the command policy does not clear.',
  'A FreeCodeGo tool this deployment has not classified is refused as well, so an unclassified tool is never silently permitted here. Reading, searching, static analysis, checks, and the memory, board, and reporting tools stay available.',
  'To change the mode, use `exit_plan_mode` or `/plan` for the user-facing path, or `engineering_plan_mode` to drive it programmatically.',
].join('\n')

/** The rules to inject, given whether a composition also mounted upstream plan mode.
 * @param upstreamComposed - whether an upstream plan mode is composed alongside this plugin.
 * @returns the guidance text to inject.
 */
export function planModeGuidanceText(upstreamComposed: boolean): string {
  return upstreamComposed ? PLAN_MODE_ENFORCEMENT_ADDENDUM : PLAN_MODE_GUIDANCE
}

/**
 * Upstream plan-mode control, as this plugin needs it.
 *
 * The Harness owns whether a conversation is in plan mode: `ctx.planMode` logs
 * the state, folds it through the `plan` projection so resume and fork restore
 * it, publishes `plan/mode`, injects the deployment's `plan:policy` section,
 * registers `exit_plan_mode`, and answers `/plan`.
 *
 * This plugin owns a different thing — *structural enforcement*, refusing a
 * mutating call instead of only asking the model not to make it — and needs the
 * mode as input. So the mode is read from upstream and written through upstream
 * whenever it is composed; the plugin's own durable store is the fallback for a
 * composition that mounted no upstream plan mode, which is why the store is kept
 * rather than deleted.
 *
 * Declared structurally rather than by importing `@deepseek-ai/dsh-plan-mode`:
 * the plugin must keep working against a Harness that predates the service, and
 * against one that ships it under a different package boundary. The two methods
 * are the whole contract this module uses.
 *
 * `pending` is read past on purpose. Upstream keeps it as the selection awaiting
 * the next accepted pre-step — a phase that exists only while an interaction is in
 * flight, and one this plugin cannot advance, because accepting pre-steps is not
 * something it does. A local copy would outlive the interaction and then report a
 * pending state for a conversation nothing is going to move. So `active` decides,
 * and `pending` stays upstream's business.
 */
export interface UpstreamPlanMode {
  /** Logged state plus any selection awaiting the next accepted pre-step. */
  readonly get: (agent: unknown) => { readonly active: boolean; readonly pending?: boolean }
  /** Select the state; the return value says whether it committed or queued. */
  readonly set: (agent: unknown, active: boolean) => 'committed' | 'queued' | 'cancelled' | 'noop'
}

/**
 * Resolve the upstream plan-mode service from a cordis context, if composed.
 *
 * `ctx.get` is total for a registered service and undefined otherwise, but it
 * can also throw while a realm is being torn down, so the lookup is guarded:
 * failing to find the authority falls back to the durable store rather than
 * taking a tool call down.
 * @param ctx - the cordis context to resolve the service from.
 * @returns the upstream service, or `undefined` when it is not composed.
 */
export function findUpstreamPlanMode(ctx: unknown): UpstreamPlanMode | undefined {
  const get = (ctx as { readonly get?: unknown } | undefined)?.get
  if (typeof get !== 'function') return undefined
  let candidate: unknown
  try { candidate = (get as (name: string) => unknown).call(ctx, 'planMode') } catch { return undefined }
  const view = candidate as Partial<UpstreamPlanMode> | undefined
  return typeof view?.get === 'function' && typeof view?.set === 'function' ? view as UpstreamPlanMode : undefined
}

interface PlanModeDocument {
  readonly version: 1
  readonly sessionId: string
  readonly mode: PlanMode
  readonly updatedAt: number
}

/** Root for plan-mode state, mirroring the engineering-memory layout.
 * @returns the plan-mode state directory.
 */
export function planModeRootDirectory(): string {
  const home = freeCodeGoDataHome()
  return join(home, 'freecodego', 'engineering', 'plan-mode')
}

function safeSessionId(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 64)
  return safe === '' ? 'session' : safe
}

/**
 * File name for one durable mode record.
 *
 * The readable spelling is retained for ordinary Harness ids, while an id that
 * needed path sanitisation gets a digest suffix. Removing path separators alone
 * maps both `a/b` and `ab` to `ab`, which lets one conversation overwrite the
 * other conversation's Plan Mode after a restart.
 */
function sessionFileName(sessionId: string): string {
  const safe = safeSessionId(sessionId)
  if (safe === sessionId) return safe
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 16)
  return `${safe}-${digest}`
}

/**
 * Create the state directory, refusing a symlinked root.
 *
 * The refusal matches the engineering-memory store: a symlink at the state root
 * would let a peer's state be written somewhere else entirely, and the check is
 * cheap enough to run once per write.
 */
async function ensureWritableDirectory(directory: string): Promise<void> {
  // The state directory itself is what the write follows, so that is what is
  // checked. Inspecting the parent (as this used to) passes whenever the parent
  // is real and the *root* is the symlink, which is the case the guard exists
  // for. Every sibling store checks the target the same way: engineering-memory,  // engineering-jobs, engineering-checkpoints, and engineering-codegraph.
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error('plan mode state directory is a symlink; refusing to write')
}

/**
 * Durable per-session Plan Mode.
 *
 * Durability is the point: a mode that a process restart silently drops is worse
 * than no mode, because the user believes the guard is on. A malformed or
 * unreadable file degrades to `execute` — the state that cannot refuse work the
 * user asked for — and the next write repairs it.
 */
export class PlanModeStore {
  private readonly cache = new Map<string, PlanMode>()
  private readonly writeChains = new Map<string, Promise<void>>()

  constructor(private readonly rootDirectory: string = planModeRootDirectory()) {}

  private fileFor(sessionId: string): string {
    return join(this.rootDirectory, `${sessionFileName(sessionId)}.json`)
  }

  /** Read one session's mode, from cache or from its durable record, defaulting to execute.
   * @param sessionId - the Harness session to read.
   * @returns the session's recorded mode.
   */
  async read(sessionId: string): Promise<PlanMode> {
    const cached = this.cache.get(sessionId)
    if (cached !== undefined) return cached
    try {
      const parsed = JSON.parse(await readFile(this.fileFor(sessionId), 'utf8')) as Partial<PlanModeDocument>
      const mode: PlanMode = parsed.mode === 'plan' ? 'plan' : 'execute'
      this.cache.set(sessionId, mode)
      return mode
    } catch {
      this.cache.set(sessionId, 'execute')
      return 'execute'
    }
  }

  /** Read without touching the filesystem; used by synchronous guards. 
   * @param sessionId - the Harness session this operation acts on.
   * @returns the cached mode, or `undefined` when the session was never read.
   */
  peek(sessionId: string): PlanMode | undefined {
    return this.cache.get(sessionId)
  }

  /**
   * Release the cached mode for one session.
   *
   * This store is owned by the plugin and keyed by session, so without this a
   * long-lived Host keeps one row for every conversation it has ever served —
   * the rule the sibling per-session views are released under. The mode itself
   * lives on disk, so forgetting costs one read if the session is seen again;
   * a pending write is deliberately left alone, because it settles the file and
   * drops its own chain entry when it finishes.
   * @param sessionId - the session to forget, spelled as {@link read} spells it.
   */
  forget(sessionId: string): void {
    this.cache.delete(sessionId)
  }

  /** Persist one session's mode, serialized against that session's earlier writes.
   * @param sessionId - the Harness session to write for.
   * @param mode - the mode to store.
   * @returns the durable document that was written.
   */
  async write(sessionId: string, mode: PlanMode): Promise<PlanModeDocument> {
    const document: PlanModeDocument = { version: 1, sessionId: safeSessionId(sessionId), mode, updatedAt: Date.now() }
    this.cache.set(sessionId, mode)
    const previous = this.writeChains.get(sessionId) ?? Promise.resolve()
    const persist = previous.catch(() => undefined).then(async () => {
      try {
        await ensureWritableDirectory(this.rootDirectory)
        const target = this.fileFor(sessionId)
      // 0600: which mode a session was last in is the user's own state.
        await writeFileAtomic(target, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
      } catch {
        // State that could not be persisted still applies in-process; the caller
        // is told the mode via the return value, and a later write retries.
      }
    })
    const settled = persist.finally(() => {
      if (this.writeChains.get(sessionId) === settled) this.writeChains.delete(sessionId)
    })
    this.writeChains.set(sessionId, settled)
    await settled
    return document
  }
}

/** Why a call is refused, or `undefined` when Plan Mode permits it. */
export interface PlanModeRefusal {
  readonly tool: string
  readonly reason: 'mutating-tool' | 'policy' | 'unclassified-tool'
  readonly message: string
}

/**
 * Decide whether Plan Mode refuses one call.
 *
 * `bash` is judged by the declarative policy rather than by a keyword list, so
 * Plan Mode cannot become a second, weaker copy of the guard's rules.
 * @param input - the mode, tool name, arguments, and compiled command policy.
 * @returns the refusal, or `undefined` when Plan Mode permits the call.
 */
export function planModeRefusal(input: {
  readonly mode: PlanMode
  readonly tool: string
  readonly args?: unknown
  readonly policy?: CompiledCommandPolicy
}): PlanModeRefusal | undefined {
  if (input.mode !== 'plan') return undefined
  const tool = input.tool.trim()
  if (PLAN_MODE_MUTATING_TOOLS.includes(tool) || PLAN_MODE_MUTATING_PLUGIN_TOOLS.includes(tool)) {
    return {
      tool,
      reason: 'mutating-tool',
      message: `Refused by Plan Mode: "${tool}" changes files, and Plan Mode only gathers truth. Reading, searching, and running checks are allowed. When the plan is decision complete, ask the user to leave Plan Mode; the mode does not end because a sentence asked for execution.`,
    }
  }
  // A plugin tool this module has not classified is refused rather than assumed
  // harmless. The other default is what made a newly added mutating tool callable
  // in Plan Mode without anyone noticing.
  if ((PLAN_MODE_PLUGIN_TOOL_PREFIXES.some(prefix => tool.startsWith(prefix)) || PLAN_MODE_UNPREFIXED_PLUGIN_TOOLS.includes(tool))
    && !PLAN_MODE_ALLOWED_PLUGIN_TOOLS.includes(tool)) {
    return {
      tool,
      reason: 'unclassified-tool',
      message: `Refused by Plan Mode: "${tool}" is a FreeCodeGo tool that this mode does not classify as safe to run while planning. Classify it in plan-mode.ts (mutating, or allowed) before using it here, then leave Plan Mode to carry it out.`,
    }
  }
  // The shell spellings this Host can actually register. `pwsh` is not optional:
  // the base `cordis.patch.yml` disables `tool-bash` on win32 and enables
  // `tool-pwsh`, so on Windows the POSIX spelling above is unreachable and this
  // whole branch would never run — the same command refused as `bash` would only
  // prompt as `pwsh`, which is the weaker answer this mode exists to avoid.
  if (tool !== 'bash' && tool !== 'shell' && tool !== 'pwsh' && tool !== 'exec_command') return undefined
  const command = commandOf(input.args)
  if (command === undefined || command.trim() === '' || input.policy === undefined) return undefined
  const evaluation = evaluateCommandPolicy(input.policy, command)
  if (evaluation.decision === 'allow') return undefined
  const suffix = evaluation.justification === undefined ? '' : ` ${evaluation.justification}`
  const decision = evaluation.decision === 'forbidden' ? 'forbidden' : 'not cleared by the command policy'
  return {
    tool,
    reason: 'policy',
    message: `Refused by Plan Mode: this command is ${decision}.${suffix} Plan Mode allows commands that only gather truth; propose the mutating step in the plan instead.`,
  }
}

function commandOf(args: unknown): string | undefined {
  const view = typeof args === 'string'
    ? (() => { try { return JSON.parse(args) as { command?: unknown } } catch { return undefined } })()
    : (args as { command?: unknown } | undefined)
  return typeof view?.command === 'string' ? view.command : undefined
}

/**
 * Derive a session id for a call whose agent id is a compound key.
 *
 * Team members and subagents share a root conversation; Plan Mode belongs to the
 * conversation the user is in, not to each worker, so the root id is what the
 * mode is keyed on.
 * @param agent - the agent whose root conversation is keyed on.
 * @returns the session key for the mode lookup.
 */
export function planModeSessionKey(agent: { readonly id?: unknown; readonly session?: { readonly header?: { readonly parentSession?: unknown } } } | undefined): string {
  const parent = agent?.session?.header?.parentSession
  const raw = typeof parent === 'string' && parent !== '' ? parent : String(agent?.id ?? 'session')
  return raw
}
