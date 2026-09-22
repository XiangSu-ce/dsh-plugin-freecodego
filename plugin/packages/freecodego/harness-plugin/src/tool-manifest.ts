/**
 * One machine-readable inventory of every tool this plugin registers.
 *
 * Why one table
 * -------------
 * A tool's name used to be written down in several places that never read each
 * other: the registration literal, Plan Mode's three lists, a role fence this
 * plugin no longer carries, and the prose in `README.md`. All of them are claims
 * about the same fact — what this tool is and what holding it means — and each
 * time the fact moved, one of them was left behind:
 *
 * - `engineering_inspect` and `engineering_hunks`, the two most direct ways to
 *   learn what a workspace contains, were classified nowhere: Plan Mode refused
 *   exactly what its own guidance tells the model to use, and reported the
 *   omission as a decision.
 * - The two worktree names were classified nowhere at all, and an unclassified
 *   tool is refused — so the readout that says where a copy lives could be held
 *   while the call that deletes it could not, and a reader had no way to see
 *   which of the two was the decision.
 * - The READMEs restate their own lists, because there was nothing to read.
 *
 * So the declaration lives here, once per tool, and the fences are *views* of it:
 * `plan-mode.ts` derives its allow and refuse lists, `verify-on-stop.ts` derives
 * the plugin half of the tools a turn may have changed the workspace with, and
 * `tests/tool-manifest.spec.ts` checks this table against the registration
 * literals discovered in this package's source — in both directions, so a tool
 * with no row and a row with no tool are both failures.
 *
 * Nothing here is inferred. A new tool fails that spec until someone writes down
 * what it is, which is the property the fences are built on: an unclassified tool
 * is refused by Plan Mode, and a role never holds authority no row grants it.
 *
 * The two fields answer two different questions
 * ---------------------------------------------
 * `capability` is what *holding* the tool needs from the reader: a name whose row
 * is not `read` is a name a turn can have moved the workspace through, which is
 * the axis `pluginToolsNeedingAuthority` selects and the reason `note` is
 * required wherever a tool needs that authority but planning may still call it.
 *
 * `planMode` is whether a *planning* turn may call it. The two do not agree for
 * every tool, and where they disagree the disagreement is the decision: a council
 * starts child Agents that are themselves started read-only, so planning may
 * dispatch one, while a verifier spawns the project's own scripts, so planning may
 * not. `note` is required wherever a tool needs authority a role must grant but
 * planning may still call it (`capability !== 'read' && planMode === 'allow'`) —
 * the spec asserts that — because a reason left unwritten is how the next reader
 * "corrects" the row back.
 *
 * Harness tool names are deliberately **not** here. This table is the plugin's own
 * surface, which is the half a source sweep can prove complete; the names an
 * engine ships (`write`, `bash`, `subagent`, an MCP server's `mcp__fs__write`)
 * are observed rather than registered, and the two consumers that must recognise
 * them keep their own spellings for that reason.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tool-manifest
 */

/** What holding a tool needs from the role holding it. */
export type ToolCapability = 'read' | 'write' | 'execute' | 'delegate'

/**
 * One tool this plugin registers, and everything a reader asks about it.
 *
 * A row exists so the two questions asked about a plugin tool — what may hold it,
 * and what Plan Mode does with it — are answered once. Both used to be answered by
 * hand-maintained lists elsewhere, and each had already missed a name.
 */
export interface PluginToolRecord {
  /** The registered name, exactly as the model sees it. */
  readonly name: string
  readonly capability: ToolCapability
  readonly planMode: 'allow' | 'refuse'
  /** Why this row reads the way it does, where the two fields do not say it alone. */
  readonly note?: string
}

/**
 * Every tool this plugin registers, with what it needs and how Plan Mode treats it.
 *
 * Order is the reading order of the surfaces (advisor, media, engineering,
 * headroom, and the four unprefixed readers), not alphabetical: a diff against
 * this table is meant to be readable next to the module it came from.
 */
export const PLUGIN_TOOL_MANIFEST: readonly PluginToolRecord[] = [
  // ── Advisor: findings, and the evidence it reads with the Harness's tools ─
  // The reviewer's `read`/`glob`/`grep` are the Harness's own tools, dispatched
  // through its registry, so they are classified there rather than listed here.
  { name: 'advisor_status', capability: 'read', planMode: 'allow' },
  { name: 'advisor_review', capability: 'read', planMode: 'allow' },
  { name: 'advisor_notes', capability: 'read', planMode: 'allow' },

  // ── Media and scheduling: output outside the repo ─────────────────────────
  // Generated images, audio and documents are written to the data home rather
  // than into the workspace, which is the same category as saving a memory: they
  // record what the project produced without changing what the project contains.
  { name: 'agnes_generate_image', capability: 'read', planMode: 'allow' },
  { name: 'agnes_generate_video', capability: 'read', planMode: 'allow' },
  { name: 'freecodego_generate_image', capability: 'read', planMode: 'allow' },
  { name: 'freecodego_generate_audio', capability: 'read', planMode: 'allow' },
  { name: 'freecodego_generate_video', capability: 'read', planMode: 'allow' },
  { name: 'freecodego_transcribe_audio', capability: 'read', planMode: 'allow' },
  { name: 'freecodego_recovery_status', capability: 'read', planMode: 'allow' },
  // Pure arithmetic over the schedule rules: it stores no reminder and creates
  // none, so planning *when* a rule falls is exactly what drafting a plan may do.
  { name: 'freecodego_schedule_plan', capability: 'read', planMode: 'allow' },

  // ── Engineering: diagnostics, memory, structure, checkpoints ──────────────
  { name: 'engineering_status', capability: 'read', planMode: 'allow' },
  { name: 'engineering_doctor', capability: 'read', planMode: 'allow' },
  { name: 'engineering_memory_search', capability: 'read', planMode: 'allow' },
  { name: 'engineering_memory_get', capability: 'read', planMode: 'allow' },
  { name: 'engineering_memory_timeline', capability: 'read', planMode: 'allow' },
  { name: 'engineering_memory_save', capability: 'read', planMode: 'allow' },
  { name: 'engineering_memory_export', capability: 'read', planMode: 'allow' },
  { name: 'engineering_handoff_create', capability: 'read', planMode: 'allow' },
  { name: 'engineering_repo_map', capability: 'read', planMode: 'allow' },
  // Checkpoints capture and read; the one that *restores* is a writer below.
  { name: 'engineering_checkpoint_capture', capability: 'read', planMode: 'allow' },
  { name: 'engineering_checkpoint_diff', capability: 'read', planMode: 'allow' },
  { name: 'engineering_checkpoint_pin', capability: 'read', planMode: 'allow' },
  { name: 'engineering_checkpoint_list', capability: 'read', planMode: 'allow' },
  {
    name: 'engineering_checkpoint_restore',
    capability: 'write',
    planMode: 'refuse',
    note: 'Its own description is "tracked files return to their recorded content and files created after the checkpoint are deleted" — the whole workspace, rolled back.',
  },
  { name: 'engineering_hunks', capability: 'read', planMode: 'allow' },
  { name: 'engineering_hunk_revert', capability: 'write', planMode: 'refuse' },
  { name: 'engineering_inspect', capability: 'read', planMode: 'allow' },
  // The review set is read: it reads the workspace and reports findings without
  // writing to it. The model calls it spends are the plugin's own route, not an
  // authority a role grants, which is why none of the four needs a note. Planning
  // may call them because a review changes nothing: a plan that proposes a change
  // is exactly when a second reading of the current diff is worth having.
  { name: 'engineering_code_review', capability: 'read', planMode: 'allow' },
  { name: 'engineering_review_rules', capability: 'read', planMode: 'allow' },
  { name: 'engineering_review_status', capability: 'read', planMode: 'allow' },
  { name: 'engineering_review_report', capability: 'read', planMode: 'allow' },
  { name: 'engineering_surface_report', capability: 'read', planMode: 'allow' },
  { name: 'engineering_persona_list', capability: 'read', planMode: 'allow' },
  { name: 'engineering_graph_status', capability: 'read', planMode: 'allow' },
  { name: 'engineering_graph_search', capability: 'read', planMode: 'allow' },
  { name: 'engineering_graph_explain', capability: 'read', planMode: 'allow' },
  { name: 'engineering_graph_path', capability: 'read', planMode: 'allow' },
  { name: 'engineering_graph_affected', capability: 'read', planMode: 'allow' },
  { name: 'engineering_graph_overview', capability: 'read', planMode: 'allow' },
  { name: 'engineering_graph_canvas', capability: 'read', planMode: 'allow' },
  { name: 'engineering_graph_mcp', capability: 'read', planMode: 'allow' },
  { name: 'engineering_codegraph_status', capability: 'read', planMode: 'allow' },
  { name: 'engineering_codegraph_explore', capability: 'read', planMode: 'allow' },
  { name: 'engineering_codegraph_search', capability: 'read', planMode: 'allow' },
  { name: 'engineering_codegraph_explain', capability: 'read', planMode: 'allow' },
  { name: 'engineering_codegraph_path', capability: 'read', planMode: 'allow' },
  { name: 'engineering_codegraph_affected', capability: 'read', planMode: 'allow' },

  // ── Plan Mode itself, and the readouts that inform a plan ─────────────────
  { name: 'engineering_plan_mode', capability: 'read', planMode: 'allow' },
  { name: 'engineering_context_budget', capability: 'read', planMode: 'allow' },
  { name: 'engineering_context_prompt', capability: 'read', planMode: 'allow' },
  // Conversation edits: they change what the parent Session carries, not what the
  // workspace will contain, which is why both fences treat them as reads.
  { name: 'engineering_context_compact', capability: 'read', planMode: 'allow' },
  { name: 'engineering_context_snip', capability: 'read', planMode: 'allow' },

  // ── Reviews and councils: read-only by construction ───────────────────────
  {
    name: 'engineering_council_review',
    capability: 'delegate',
    planMode: 'allow',
    note: 'It starts child Agents, but every participant is started read-only, so dispatching one during planning cannot change the workspace.',
  },
  {
    name: 'engineering_team_start',
    capability: 'delegate',
    planMode: 'allow',
    note: 'Same shape as a council: the children are started read-only, and knowing who you could dispatch is part of planning.',
  },
  {
    name: 'engineering_subagent_start',
    capability: 'delegate',
    planMode: 'refuse',
    note: 'Starting a persona child is how a fenced conversation would get its writing done: the child is a different session, so the fence has to refuse the delegation rather than only the write the child would make.',
  },
  { name: 'engineering_team_status', capability: 'read', planMode: 'allow' },
  { name: 'engineering_team_report', capability: 'read', planMode: 'allow' },
  { name: 'engineering_team_cancel', capability: 'read', planMode: 'allow' },
  { name: 'engineering_team_request_approval', capability: 'read', planMode: 'allow' },
  { name: 'engineering_team_mark_implemented', capability: 'read', planMode: 'allow' },
  {
    name: 'engineering_team_verify',
    capability: 'execute',
    planMode: 'refuse',
    note: 'It writes nothing itself and reaches the machine anyway: its stages spawn the project\'s build/type/lint/test scripts and up to five probe programs the model authored, which is the authority `bash` carries.',
  },

  // ── Worktrees: readouts, and the two that cut and delete trees ────────────
  { name: 'engineering_worktree_status', capability: 'read', planMode: 'allow' },
  { name: 'engineering_worktree_list', capability: 'read', planMode: 'allow' },
  {
    name: 'engineering_worktree_enter',
    capability: 'write',
    planMode: 'refuse',
    note: 'Isolating a copy cuts a git branch and writes a whole tree, so it must not be reachable while the workspace is supposed to be frozen.',
  },
  {
    name: 'engineering_worktree_exit',
    capability: 'write',
    planMode: 'refuse',
    note: 'With `remove` it deletes a tree — a conversation\'s uncommitted work is what disappears.',
  },

  // ── The plugin\'s own tools that write ────────────────────────────────────
  {
    name: 'edit_and_run',
    capability: 'write',
    planMode: 'refuse',
    note: 'Edits a file and runs the command that proves the edit landed; it is also the one tool registered with no plugin prefix, so it is reached by name rather than by prefix.',
  },

  // ── Headroom and the unprefixed readers ───────────────────────────────────
  { name: 'headroom_retrieve', capability: 'read', planMode: 'allow' },
  { name: 'inspect', capability: 'read', planMode: 'allow' },
  { name: 'read_document', capability: 'read', planMode: 'allow' },
  { name: 'spill_recall', capability: 'read', planMode: 'allow' },
]

const BY_NAME = new Map(PLUGIN_TOOL_MANIFEST.map(tool => [tool.name, tool]))

/** Every registered name, in manifest order. */
export const PLUGIN_TOOL_NAMES: readonly string[] = PLUGIN_TOOL_MANIFEST.map(tool => tool.name)

/**
 * One row, or `undefined` for a name this plugin does not register.
 * @param name - a tool name, exactly as the model would call it.
 * @returns That row, or `undefined` when the name belongs to another plugin.
 */
export function pluginTool(name: string): PluginToolRecord | undefined {
  return BY_NAME.get(name)
}

/**
 * What holding this plugin tool needs — the row's own authority, as one lookup.
 *
 * `undefined` for a name this plugin does not register, and `'read'` for one it
 * does: a caller that also knows harness spellings asks its own patterns first
 * and falls back here, so the two vocabularies never have to be compared. The
 * runtime reader of this axis is {@link pluginToolsNeedingAuthority}; the lookup
 * itself stays exported because the manifest's own spec asks it name by name.
 * @param name - a tool name, exactly as the model would call it.
 * @returns The capability that name needs, or `undefined` when this plugin does not register it.
 */
export function pluginToolCapability(name: string): ToolCapability | undefined {
  return BY_NAME.get(name)?.capability
}

/**
 * The names with one Plan Mode verdict, in manifest order.
 * @param planMode - the verdict to select.
 * @returns The names Plan Mode treats that way, in manifest order.
 */
export function pluginToolsWithPlanMode(planMode: 'allow' | 'refuse'): readonly string[] {
  return PLUGIN_TOOL_MANIFEST.filter(tool => tool.planMode === planMode).map(tool => tool.name)
}

/**
 * Every name whose row is not a read — `capability !== 'read'`.
 *
 * This axis rather than one capability, because `verify-on-stop.ts` wants the
 * whole set at once: needing *any* authority is what makes a tool one a turn
 * can have changed the workspace through — and a turn that changed nothing must
 * not be filed as one that did, which is the gate that nudge exists for. That
 * module used to hold its own four names, and the list it held had already missed
 * `engineering_subagent_start`.
 * @returns Every registered name that is not `read`, in manifest order.
 */
export function pluginToolsNeedingAuthority(): readonly string[] {
  return PLUGIN_TOOL_MANIFEST.filter(tool => tool.capability !== 'read').map(tool => tool.name)
}

/**
 * The names no plugin prefix covers, which a prefix-driven reader cannot reach.
 * @param prefixes - the name prefixes a reader already handles.
 * @returns The registered names that start with none of them, in manifest order.
 */
export function pluginToolsWithoutPrefix(prefixes: readonly string[]): readonly string[] {
  return PLUGIN_TOOL_NAMES.filter(name => !prefixes.some(prefix => name.startsWith(prefix)))
}
