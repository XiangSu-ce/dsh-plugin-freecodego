/**
 * Where a skill goes, over `--agent` × `--scope`.
 *
 * Skills are found in different directories by different agents, and the whole
 * point of installing one into a shared location is that the *other* agent picks
 * it up. So placement is an explicit two-axis choice rather than a default:
 *
 * | scope \ agent | harness native | shared agents | custom |
 * |---|---|---|---|
 * | project | `.dsh/skills` | `.agents/skills` | — |
 * | user | `$DSH_HOME/skills` | `~/.agents/skills` | a configured root |
 *
 * The project tier is gated on folder trust (G1), and the gate runs **before the
 * path is built**, not after: an untrusted checkout's `.agents/skills` is a
 * directory the repository controls, and installing into it is a write the
 * repository asked for.
 *
 * Note what is absent: there is no "write to both" mode. Installing the same
 * skill into two roots produces two copies that drift, and the collision report
 * would then flag a skill as colliding with itself.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/skills/placement
 */

/** Which agent will read the skill. */
export type SkillAgent = 'harness' | 'agents' | 'custom'

/** Whether the skill is available to this repository or to this user. */
export type SkillScope = 'project' | 'user'

/** What the caller asked for, plus the roots it may write into. */
export interface PlacementRequest {
  readonly agent: SkillAgent
  readonly scope: SkillScope
  /** Repository root, required for the project scope. */
  readonly workspace?: string
  /** `$DSH_HOME`, required for the user scope. */
  readonly dataHome?: string
  /** `~`, required for the shared-agents user scope. */
  readonly home?: string
  /** Explicit root, required for `agent: 'custom'`. */
  readonly customRoot?: string
  /** Whether the folder is trusted; the project scope requires it. */
  readonly projectTrusted: boolean
}

/** The resolved destination, or the reason there is none. */
export type PlacementResult =
  | { readonly ok: true; readonly root: string; readonly provenance: string }
  | { readonly ok: false; readonly reason: string }

/** Join path segments without importing `path` semantics for a display value. */
function join(...segments: readonly string[]): string {
  return segments
    .filter(segment => segment !== '')
    .join('/')
    .replace(/\/{2,}/g, '/')
    .replace(/(.)\/$/, '$1')
}

/**
 * Resolve where a skill should be installed.
 * @param request - the two-axis choice and the roots it may use.
 * @returns the destination, or a reason it cannot be resolved.
 */
export function resolveSkillPlacement(request: PlacementRequest): PlacementResult {
  // The gate is before the path, not after, and it is before the *agent* choice
  // too: an untrusted repository must not have the destination computed from its
  // own contents. It applies to `custom` as well, which used to return its root
  // before reaching this check — a custom root is exactly the spelling that can
  // itself come from the repository's configuration, so trusting the agent field to
  // mean "the user chose this" was trusting the wrong thing.
  if (request.scope === 'project' && !request.projectTrusted) {
    return { ok: false, reason: 'installing into the project requires a trusted folder; trust it, or install with --scope user' }
  }

  if (request.agent === 'custom') {
    const root = request.customRoot
    if (root === undefined || root === '') {
      return { ok: false, reason: 'agent "custom" needs a custom root; set one or choose harness/agents' }
    }
    return { ok: true, root, provenance: 'custom root' }
  }

  if (request.scope === 'project') {
    const workspace = request.workspace
    if (workspace === undefined || workspace === '') {
      return { ok: false, reason: 'the project scope needs a workspace root' }
    }
    return request.agent === 'agents'
      ? { ok: true, root: join(workspace, '.agents/skills'), provenance: 'project, shared agents' }
      : { ok: true, root: join(workspace, '.dsh/skills'), provenance: 'project, harness native' }
  }

  if (request.agent === 'agents') {
    const home = request.home
    if (home === undefined || home === '') {
      return { ok: false, reason: 'the shared-agents user scope needs a home directory' }
    }
    return { ok: true, root: join(home, '.agents/skills'), provenance: 'user, shared agents' }
  }

  const dataHome = request.dataHome
  if (dataHome === undefined || dataHome === '') {
    return { ok: false, reason: 'the user scope needs a data home' }
  }
  return { ok: true, root: join(dataHome, 'skills'), provenance: 'user, harness native' }
}

/** Every agent × scope combination this table must answer, for the exhaustive test. */
export const PLACEMENT_COMBINATIONS: readonly { readonly agent: SkillAgent; readonly scope: SkillScope }[] = [
  { agent: 'harness', scope: 'project' },
  { agent: 'harness', scope: 'user' },
  { agent: 'agents', scope: 'project' },
  { agent: 'agents', scope: 'user' },
  { agent: 'custom', scope: 'project' },
  { agent: 'custom', scope: 'user' },
]
