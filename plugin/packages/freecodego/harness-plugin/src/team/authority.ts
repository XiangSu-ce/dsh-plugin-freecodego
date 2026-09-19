/**
 * Which module owns a team, once the Harness also ships one.
 *
 * The duplication this settles
 * ----------------------------
 * The Harness has a team runtime: `@deepseek-ai/dsh-experimental-agent-team`
 * provides `ctx.agentTeams`, and `.../tool-agent-team` registers the model-facing
 * half of it — `spawn_teammate`, `send_message`, `list_agents`, `wait_agent`,
 * `interrupt_agent`, and `team_task_create` / `_list` / `_get` / `_update` with
 * readiness, blockers, revisions, and advisory write scopes. This plugin grew a
 * second one of the same thing: a claimable board, a durable per-member mailbox,
 * a member registry, and its own start/stop pair.
 *
 * Both were mounted in this composition, so both were live at once, and that is
 * worse than either alone. They are not two views of one team; they are two
 * teams. A member started through `engineering_team_member_start` is a child
 * Agent the Harness's roster has never heard of, so `list_agents` does not list
 * it, `interrupt_agent` cannot reach it, and `wait_agent` will not wake for it.
 * A task created on the plugin's board is invisible to `team_task_list`, so a
 * teammate cannot pick it up. Neither failure raises anything — each surface
 * simply answers about a team the other one cannot see.
 *
 * What is decided here
 * --------------------
 * The Harness owns the team when it is composed. Its runtime is the one the
 * other members, the roster, the mailbox, and the projection already agree on,
 * and duplicating it means duplicating all of that. So the plugin does not
 * register the tools the Harness supersedes, and keeps the parts of its team
 * layer the Harness has no equivalent for:
 *
 * - **Writer isolation.** A writing member gets its own git worktree, and the
 *   shared tree changes only through an explicit `engineering_team_merge`, which
 *   is the one merge point. The Harness spawns teammates and tracks write scopes
 *   but does not isolate or merge a tree.
 * - **Recovery.** `engineering_team_recover` reconciles members and tasks left
 *   inconsistent by a crash.
 *
 * The plugin's board, mailbox, and member registry stay implemented and tested,
 * because they are the fallback for a composition that mounts no team runtime at
 * all — the same shape as the plan-mode and approval seams: one authority, read
 * through one place, with the local implementation as the fallback rather than a
 * peer.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/team/authority
 */

/**
 * The Harness's team service, as this plugin needs it.
 *
 * Declared structurally rather than imported from
 * `@deepseek-ai/dsh-experimental-agent-team`: the plugin must keep loading
 * against a Harness that predates the service, and the only question asked of it
 * here is whether it is present. The member and task methods are named so a
 * reader can see which half of the Harness this corresponds to, but nothing in
 * this plugin calls them — the model reaches the Harness through the Harness's
 * own tools.
 */
export interface UpstreamTeams {
  /** Resolve one live Agent's team membership. */
  readonly membership: (agent: unknown) => unknown
  /** List the roster visible to one member. */
  readonly listMembers: (agent: unknown) => readonly unknown[]
  /** List the shared task board visible to one member. */
  readonly listTasks: (caller: unknown) => readonly unknown[]
}

/**
 * The plugin tools the Harness's team runtime supersedes.
 *
 * Named rather than inferred, and kept in one list, so that the set the plugin
 * stops registering is reviewable in a diff and can be asserted against the
 * source. Each one has a Harness counterpart that already answers for the same
 * team:
 *
 * - `engineering_team_board` / `_plan` / `_claim` / `_task_update` →
 *   `team_task_list` / `_create` / `_update`, on the one board the roster reads
 * - `engineering_team_member_start` / `_stop` → `spawn_teammate` /
 *   `interrupt_agent`, on the one roster the mailbox and `list_agents` read
 */
export const HARNESS_TEAM_OWNED_TOOLS: readonly string[] = [
  'engineering_team_board',
  'engineering_team_plan',
  'engineering_team_claim',
  'engineering_team_task_update',
  'engineering_team_member_start',
  'engineering_team_member_stop',
]

/**
 * The plugin tools that survive beside the Harness's team runtime.
 *
 * Stated as its own list because the interesting assertion is not that the
 * superseded names are skipped, it is that these two are not: skipping them
 * would take away writer isolation and crash recovery, which is a capability
 * loss rather than a deduplication.
 */
export const PLUGIN_TEAM_ENHANCEMENT_TOOLS: readonly string[] = [
  'engineering_team_merge',
  'engineering_team_recover',
]

/**
 * Resolve the Harness's team service from a cordis context, if composed.
 *
 * Guarded because `ctx.get` can throw while a realm is tearing down, and a
 * failure to look this up must leave the plugin's own team surface standing
 * rather than taking the tool registry down with it. Requiring all three methods
 * rather than any one keeps a partially different service from being mistaken
 * for this one.
 */
export function findUpstreamTeams(ctx: unknown): UpstreamTeams | undefined {
  const get = (ctx as { readonly get?: unknown } | undefined)?.get
  if (typeof get !== 'function') return undefined
  let candidate: unknown
  try { candidate = (get as (name: string) => unknown).call(ctx, 'agentTeams') } catch { return undefined }
  const view = candidate as Partial<UpstreamTeams> | undefined
  return typeof view?.membership === 'function'
    && typeof view?.listMembers === 'function'
    && typeof view?.listTasks === 'function'
    ? view as UpstreamTeams
    : undefined
}
