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
 * The roots are joined by `node:path`, not by string concatenation, because these
 * strings are an *identity* rather than a label: the lockfile records one, the
 * capability registry keys a root by it, and the install/removal/dedupe paths all
 * compare them for equality. A hand-written `/` join would spell one directory two
 * ways on Windows (`C:\data/skills` beside `C:\data\skills`), and two spellings of one
 * root is how an install ends up invisible to the reader looking beside it.
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

import { join } from 'node:path'

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

/**
 * What resolving the whole matrix needs besides the choice itself.
 *
 * The roots are the caller's to supply rather than read from the process here: the
 * Host knows `$DSH_HOME`, the home directory, and whether the folder it is running
 * in has been trusted, and a module that read them itself would be a second place
 * that decides what an untrusted folder is.
 */
export interface PlacementContext {
  /** Repository root the session is working in. */
  readonly workspace: string
  /** `$DSH_HOME`, for the harness-native user root. */
  readonly dataHome?: string
  /** `~`, for the shared-agents user root. */
  readonly home?: string
  /** Explicit root, for `agent: 'custom'`. */
  readonly customRoot?: string
  /** Whether the folder this Host runs in has been trusted. */
  readonly projectTrusted: boolean
}

/** One row of the matrix, resolved: a destination, or the reason there is none. */
export type PlacementRow =
  | { readonly agent: SkillAgent; readonly scope: SkillScope; readonly ok: true; readonly root: string; readonly provenance: string }
  | { readonly agent: SkillAgent; readonly scope: SkillScope; readonly ok: false; readonly reason: string }

/**
 * Resolve every combination the table lists.
 *
 * The whole matrix rather than the one row a caller asked for, because an install
 * surface has to be able to show the *reasons*: "project scope is unavailable here"
 * is a fact about the folder, and a user who only ever sees the disabled option
 * cannot tell an untrusted repository from one where the feature is off.
 * @param context - the two axes' roots and the folder's trust.
 * @returns one row per combination, in the table's own order.
 */
export function resolveSkillPlacements(context: PlacementContext): readonly PlacementRow[] {
  return PLACEMENT_COMBINATIONS.map(({ agent, scope }) => {
    const resolved = resolveSkillPlacement({
      agent, scope,
      workspace: context.workspace,
      ...(context.dataHome === undefined ? {} : { dataHome: context.dataHome }),
      ...(context.home === undefined ? {} : { home: context.home }),
      ...(context.customRoot === undefined ? {} : { customRoot: context.customRoot }),
      projectTrusted: context.projectTrusted,
    })
    return resolved.ok
      ? { agent, scope, ok: true, root: resolved.root, provenance: resolved.provenance }
      : { agent, scope, ok: false, reason: resolved.reason }
  })
}

/**
 * The managed-root id one placement's install is mounted under.
 *
 * Per placement rather than one shared id, because the capability registry keys a
 * root by id as well as by path: reusing the Marketplace's id for a project install
 * would *unmount* the community root it names, and the Skills page would lose the
 * list it just installed into.
 * @param agent - the first axis of the choice.
 * @param scope - the second axis of the choice.
 * @returns a stable, filesystem-safe root id.
 */
export function placementRootId(agent: SkillAgent, scope: SkillScope): string {
  return `freecodego-skill-${agent}-${scope}`
}
