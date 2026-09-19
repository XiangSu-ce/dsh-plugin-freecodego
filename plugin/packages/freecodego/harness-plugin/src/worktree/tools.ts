/**
 * Session worktrees: entering, leaving, and reporting on one isolated writer.
 *
 * What this restores
 * ------------------
 * A previous revision of this plugin had session-level worktree enter/exit and
 * lost it. What a session does with one is: run in a copy of the repository so
 * its writes cannot interleave with anyone else's, and hand the copy back (or
 * keep it for review) when it is done. `team/worktree.ts` already does this for
 * team members; this is the same idea keyed on a session rather than a member,
 * sharing that module's registry rather than starting a second one.
 *
 * The one thing this cannot do, stated plainly
 * --------------------------------------------
 * The design asks `enter` to change *this session's working directory*. It
 * cannot: the Harness sets `session.header.cwd` when the session is created and
 * exposes no seam that revises it, and every filesystem tool reads that header
 * (`fs/tool-fs/src/session-cwd.ts`). So `enter` creates the worktree, records it
 * against the session, and returns the path — and the honest report of what a
 * caller now has, rather than a claim that the cwd moved. A caller that needs
 * the redirect to be *real* has to create a session whose `cwd` is the worktree,
 * which is exactly what the persona's `default_isolation` does for a spawned
 * child (`persona/resolve.ts`): a child is created *with* a cwd, so its tools
 * genuinely run in the copy.
 *
 * That split is the module's whole shape: **isolation is enforced where the cwd
 * is still open** (a child session being created), and reported where it is not
 * (a conversation already running).
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/worktree/tools
 */

import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { WORKTREE_RELATIVE_DIRECTORY, type TeamWorktree } from '../team/worktree.ts'
import { redactCredentialShapes } from '../secret-scan.ts'
import type { ToolDefinitionShape } from '../tool-definition.ts'
import type { WorktreeCreation, WorktreeStrategyRequest } from './creator.ts'

/** Marks a registry entry as owned by a session rather than by a team member. */
const SESSION_MEMBER_PREFIX = 'session:'

/**
 * A directory name for one session.
 *
 * The sanitized id keeps the name readable, and the short digest of the *raw* id
 * is what keeps two ids that sanitize to the same string apart — the failure the
 * team allocator's comment already names, where two ids collide into one
 * directory and silently share one worktree.
 * @param sessionId - the session the name is for.
 * @returns a name safe to use as a path segment.
 */
export function sessionWorktreeSlug(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 32) || 'session'
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 8)
  return `${safe}-${digest}`
}

/** Everything derived from a session id, so no caller derives a second copy. */
export interface SessionWorktreePlan {
  readonly id: string
  readonly sessionId: string
  readonly memberId: string
  readonly slug: string
  readonly branch: string
  readonly path: string
  readonly workspaceRoot: string
}

/**
 * Where a session's worktree lives, and what it is called.
 *
 * One function for all five derived names, because a caller that derives the
 * path itself and the branch differently is a caller that removes one worktree
 * and registers another.
 * @param input - the workspace and the session.
 * @returns the plan, with an absolute path inside the workspace.
 */
export function sessionWorktreePlan(input: { readonly workspaceRoot: string; readonly sessionId: string }): SessionWorktreePlan {
  const slug = sessionWorktreeSlug(input.sessionId)
  return {
    id: `wt_${slug}`,
    sessionId: input.sessionId,
    memberId: `${SESSION_MEMBER_PREFIX}${input.sessionId}`,
    slug,
    branch: `freecodego/session/${slug}`,
    path: join(input.workspaceRoot, WORKTREE_RELATIVE_DIRECTORY, slug),
    workspaceRoot: input.workspaceRoot,
  }
}

/** Who a registry entry belongs to. */
export function worktreeOwner(memberId: string): { readonly kind: 'session'; readonly sessionId: string } | { readonly kind: 'member' } {
  return memberId.startsWith(SESSION_MEMBER_PREFIX)
    ? { kind: 'session', sessionId: memberId.slice(SESSION_MEMBER_PREFIX.length) }
    : { kind: 'member' }
}

/** The registry operations this module needs, as `TeamWorktrees` provides them. */
export interface WorktreeRegistry {
  list(): Promise<readonly TeamWorktree[]>
  register(entry: TeamWorktree): Promise<void>
}

/** Everything the session worktrees need from the outside world, injected. */
export interface SessionWorktreePorts {
  readonly registry: WorktreeRegistry
  /** Create the working copy; `creator.ts` is the only intended implementation. */
  readonly create: (input: {
    readonly repoRoot: string
    readonly targetPath: string
    readonly branch: string
    readonly requested: WorktreeStrategyRequest
  }) => Promise<WorktreeCreation>
  /** Remove an existing working copy, by strategy. */
  readonly remove: (input: { readonly repoRoot: string; readonly path: string; readonly strategy: 'git' | 'fast' }) => Promise<void>
  /** Keep the worktree directory out of `git status`; best effort. */
  readonly exclude?: (repoRoot: string) => Promise<void>
  /** The commit the copy was taken from, when it can be asked. */
  readonly head?: (repoRoot: string) => Promise<string | undefined>
  /** Whether a path is a directory. */
  readonly exists?: (path: string) => boolean
  /** Recursive size of a directory, in bytes. */
  readonly size?: (path: string) => number
  readonly now?: () => number
}

/** What `enter` produced, including what it could not do. */
export interface WorktreeEnterOutcome {
  readonly worktree: TeamWorktree
  /** True when an existing worktree for this session was returned rather than a new one. */
  readonly reused: boolean
  readonly strategy: 'git' | 'fast'
  readonly fallbackReason?: string
  /**
   * The sentence the caller must read before assuming its tools moved: they did
   * not, and the path is what it uses.
   */
  readonly isolation: string
}

/** What `exit` did. */
export interface WorktreeExitOutcome {
  readonly removed: boolean
  readonly worktree?: TeamWorktree
  readonly detail: string
}

/** One row of `list`, with the owner resolved. */
export interface WorktreeRow {
  readonly worktree: TeamWorktree
  readonly owner: 'session' | 'member'
  readonly sessionId?: string
  readonly exists: boolean
  readonly bytes?: number
}

const DEFAULT_EXISTS = (path: string): boolean => existsSync(path)

/**
 * The strategy an entry was created with.
 *
 * Recorded on the entry, which is why the field exists; the branch is the
 * fallback for an entry written before it did, and "no branch" is exactly what a
 * fast copy has. One function so a caller that reuses a copy reports the same
 * strategy `enter` recorded when it made it.
 * @param entry - the registered worktree.
 * @returns which implementation produced its directory.
 */
function recordedStrategy(entry: TeamWorktree): 'git' | 'fast' {
  return entry.strategy ?? (entry.branch === '' ? 'fast' : 'git')
}

/**
 * Recursive size of a directory, skipping what cannot be read.
 *
 * A link to a directory is counted as the link rather than descended into, which
 * is the difference between a report and a hang: `statSync` follows links, and a
 * working copy of a repository that contains one — a pnpm `node_modules`, a
 * junction a developer left behind — can point back into a tree this walk is
 * already inside. `lstatSync` is what makes the walk terminate on the shape of
 * the directory rather than on wherever its links lead.
 * @param root - the directory to measure.
 * @returns the total byte size of the files reached without following links.
 */
function directoryBytes(root: string): number {
  let total = 0
  const walk = (directory: string): void => {
    let entries: readonly Dirent[]
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(directory, entry.name)
      try {
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        // A link is measured as itself. A file link's own size is the length of
        // its target text, which is what the directory entry actually occupies.
        total += lstatSync(full).size
      } catch {
        // A file that vanished mid-walk is not a reason to fail the report.
      }
    }
  }
  walk(root)
  return total
}

export class SessionWorktrees {
  constructor(private readonly ports: SessionWorktreePorts) {}

  private get exists(): (path: string) => boolean {
    return this.ports.exists ?? DEFAULT_EXISTS
  }

  private get now(): number {
    return this.ports.now?.() ?? Date.now()
  }

  /** The active entry a session holds, if any. */
  async held(sessionId: string): Promise<TeamWorktree | undefined> {
    const entries = await this.ports.registry.list()
    return entries.find(entry => entry.memberId === `${SESSION_MEMBER_PREFIX}${sessionId}` && entry.state === 'active')
  }

  /**
   * The copy a session left behind when it exited, if it left one.
   *
   * Only `abandoned` counts, and that is the state `exit` writes: a copy whose
   * branch was merged into the workspace is not a place to start writing again,
   * because the merge already accounts for the tree as it stood. Newest first,
   * because a session that somehow left two is served by the later one.
   * @param sessionId - the session to look up.
   * @returns the entry, or `undefined` when nothing was left.
   */
  private async keptBySession(sessionId: string): Promise<TeamWorktree | undefined> {
    const memberId = `${SESSION_MEMBER_PREFIX}${sessionId}`
    const kept = (await this.ports.registry.list()).filter(entry => entry.memberId === memberId && entry.state === 'abandoned')
    return kept.sort((left, right) => right.createdAt - left.createdAt)[0]
  }

  /**
   * Give a session its own working copy.
   *
   * Re-entering returns what the session already holds, because a second copy
   * would orphan the first: it stays on disk, still registered under an id
   * nobody queries again. A directory that has since been deleted is not reused
   * — it is replaced, since "held" has to mean the copy is actually there.
   * @param input - the workspace, the session, and how much the copy is worth.
   * @returns the worktree and what the caller can rely on.
   */
  async enter(input: {
    readonly workspaceRoot: string
    readonly sessionId: string
    readonly repoRoot?: string
    readonly requested?: WorktreeStrategyRequest
    readonly ref?: string
  }): Promise<WorktreeEnterOutcome> {
    const plan = sessionWorktreePlan({ workspaceRoot: input.workspaceRoot, sessionId: input.sessionId })
    const existing = await this.held(input.sessionId)
    if (existing !== undefined && this.exists(existing.path)) {
      return {
        worktree: existing,
        reused: true,
        strategy: recordedStrategy(existing),
        isolation: isolationNote(existing.path, true),
      }
    }
    // A copy this session left in place is still this session's copy. `exit`
    // keeps it by default — the reviewer's next question is what it changed — so
    // after that exit the entry is `abandoned` while the directory is very much
    // there. Creating again at that path is what loses it, and both real
    // strategies lose it differently: the git one asks for a branch and a path
    // that already exist, and the copy it falls back to is then handed the
    // occupied directory, which merges the source tree over the session's edits
    // (or throws where a worktree's `.git` file sits, and that throw reaches the
    // cleanup below, which deletes the directory). Walking back into it is the
    // decision `team/worktree.ts` already makes for a member — "existence is the
    // whole test" — read one state wider.
    if (existing === undefined) {
      const kept = await this.keptBySession(input.sessionId)
      if (kept !== undefined && this.exists(kept.path)) {
        // Re-registered rather than returned as it stands: `held`, `status` and a
        // later `exit` all read the registry, so the entry has to say the session
        // holds this copy again or the next call will not find it.
        const reactivated: TeamWorktree = { ...kept, state: 'active' }
        await this.ports.registry.register(reactivated)
        return {
          worktree: reactivated,
          reused: true,
          strategy: recordedStrategy(reactivated),
          isolation: isolationNote(reactivated.path, true),
        }
      }
    }
    const repoRoot = input.repoRoot ?? input.workspaceRoot
    await mkdir(join(input.workspaceRoot, WORKTREE_RELATIVE_DIRECTORY), { recursive: true, mode: 0o700 })
    if (this.ports.exclude !== undefined) {
      try {
        await this.ports.exclude(repoRoot)
      } catch {
        // Invariant 1 is about status noise. Losing it must not lose the copy.
      }
    }
    let created: WorktreeCreation
    try {
      created = await this.ports.create({
        repoRoot,
        targetPath: plan.path,
        branch: plan.branch,
        requested: input.requested ?? 'auto',
      })
    } catch (error) {
      // Invariant 4: a failed creation leaves no half-made directory. A partial
      // copy is worse than no copy, because the next `enter` would reuse it.
      try {
        if (this.exists(plan.path)) rmSync(plan.path, { recursive: true, force: true })
      } catch {
        // Reported through the original error below rather than replaced by it.
      }
      throw error
    }
    const base = created.strategy === 'git'
      ? (await this.ports.head?.(repoRoot)) ?? input.ref ?? ''
      : ''
    const worktree: TeamWorktree = {
      id: plan.id,
      memberId: plan.memberId,
      sessionId: plan.sessionId,
      // A fast copy has no branch. Recording the intended name here would make
      // `integrate` offer to merge something that does not exist.
      branch: created.strategy === 'git' ? plan.branch : '',
      path: created.path,
      base,
      createdAt: this.now,
      state: 'active',
      strategy: created.strategy,
    }
    await this.ports.registry.register(worktree)
    return {
      worktree,
      reused: false,
      strategy: created.strategy,
      ...(created.fallbackReason === undefined ? {} : { fallbackReason: created.fallbackReason }),
      isolation: isolationNote(created.path, false),
    }
  }

  /**
   * Stop using a session's working copy.
   *
   * Leaving keeps the copy and its branch by default, because the reviewer's next
   * question is "what did it change" and removing the tree answers that by
   * destroying the evidence. `remove: true` is the explicit request to discard
   * it, and it is the only path here that deletes anything.
   *
   * A discard that did not happen is reported as one, and the entry stays active:
   * the registration is what makes a surviving copy findable, so "released" and
   * "still on disk" must not be recorded together.
   * @param input - the session, and whether to discard the copy.
   * @returns what happened, including when there was nothing to do.
   */
  async exit(input: { readonly sessionId: string; readonly remove?: boolean; readonly repoRoot?: string }): Promise<WorktreeExitOutcome> {
    const worktree = await this.held(input.sessionId)
    if (worktree === undefined) {
      return { removed: false, detail: 'This session holds no worktree.' }
    }
    if (input.remove === true) {
      const strategy = recordedStrategy(worktree)
      try {
        await this.ports.remove({ repoRoot: input.repoRoot ?? worktree.path, path: worktree.path, strategy })
      } catch (error) {
        // The registry entry is kept active on a failed removal: marking it
        // released while the directory is still there is how a worktree becomes
        // invisible and unremovable.
        // A removal that fails on a git command quotes git's own output, which
        // is the same reason the creation path masks its fallback reason: git
        // echoes the remote it was given, credentials included.
        return {
          removed: false,
          worktree,
          detail: `The worktree could not be removed: ${redactCredentialShapes(error instanceof Error ? error.message : String(error))}. It is still registered, so a later exit can retry.`,
        }
      }
      // A port that returned normally is not evidence that the copy is gone. The
      // git port reports git's own failures in a result object rather than by
      // throwing, so a refused `git worktree remove` used to arrive here looking
      // like a success and the copy was recorded as released while it was still
      // on disk — nothing listing it as live and nothing offering to remove it
      // again, which is the same invisibility the catch above exists to prevent.
      // Asking the directory is the only answer that does not depend on the port
      // being honest about what it did.
      if (this.exists(worktree.path)) {
        return {
          removed: false,
          worktree,
          detail: `The worktree could not be removed: ${worktree.path} is still on disk. It is still registered, so a later exit can retry.`,
        }
      }
    }
    const released: TeamWorktree = { ...worktree, state: 'abandoned' }
    await this.ports.registry.register(released)
    return {
      removed: input.remove === true,
      worktree: released,
      detail: input.remove === true
        ? `Removed ${released.path}${released.branch === '' ? ' (the copy had no branch to delete)' : `; branch ${released.branch} was kept`}.`
        : `Left ${released.path} in place for review, on the copy's own branch. Pass remove: true to discard it.`,
    }
  }

  /**
   * What a session currently holds.
   *
   * The size is measured rather than estimated: a pool and a set of held copies
   * are disk, and the number that makes that legible is bytes on disk.
   * @param input - the session and its workspace.
   * @returns the entry, whether the directory is really there, and its size.
   */
  async status(input: { readonly sessionId: string; readonly workspaceRoot: string }): Promise<WorktreeRow | undefined> {
    const entries = await this.ports.registry.list()
    const plan = sessionWorktreePlan(input)
    const entry = entries.find(candidate => candidate.memberId === plan.memberId)
      ?? entries.find(candidate => candidate.id === plan.id)
    return entry === undefined ? undefined : this.row(entry)
  }

  /**
   * Every worktree in the registry, whoever owns it.
   *
   * Deliberately not filtered to this workspace: the registry is per workspace
   * already (`TeamJsonStore` refuses a document whose `cwd` differs), so a filter
   * here would only hide a mismatch worth seeing.
   * @returns one row per entry, newest first.
   */
  async list(): Promise<readonly WorktreeRow[]> {
    const entries = await this.ports.registry.list()
    return entries
      .map(entry => this.row(entry))
      .sort((left, right) => right.worktree.createdAt - left.worktree.createdAt)
  }

  private row(entry: TeamWorktree): WorktreeRow {
    const owner = worktreeOwner(entry.memberId)
    const exists = this.exists(entry.path)
    return {
      worktree: entry,
      owner: owner.kind,
      ...(owner.kind === 'session' ? { sessionId: owner.sessionId } : {}),
      exists,
      // Only measured when it is there: a size for a directory that does not
      // exist would read as an empty worktree rather than a missing one.
      ...(exists ? { bytes: (this.ports.size ?? directoryBytes)(entry.path) } : {}),
    }
  }
}

/**
 * The sentence a caller must not have to infer.
 *
 * A worktree this plugin made does not move the conversation's cwd, and a reader
 * who assumes it does will run every later command in the shared tree while
 * believing it is isolated — the exact failure the feature exists to prevent.
 * @param path - the working copy.
 * @param reused - whether the session already held it.
 * @returns the note, including the relative form when the workspace contains it.
 */
export function isolationNote(path: string, reused: boolean): string {
  return `This session's working copy is ${path}${reused ? ' (already held; nothing was created)' : ''}. `
    + 'The Harness fixes a session\'s working directory when it is created, so this conversation\'s file and shell '
    + 'calls still resolve against its original workspace — pass absolute paths under this copy to work in it. '
    + 'A session created *with* this path as its working directory (a child spawned under a persona whose '
    + 'default_isolation is "worktree") has the redirect for real.'
}

/** The registry entry for a session, formatted for a tool result. */
export function summarizeWorktree(row: WorktreeRow): Record<string, unknown> {
  return {
    id: row.worktree.id,
    path: row.worktree.path,
    owner: row.owner,
    ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }),
    branch: row.worktree.branch === '' ? null : row.worktree.branch,
    state: row.worktree.state,
    strategy: row.worktree.strategy ?? null,
    exists: row.exists,
    ...(row.bytes === undefined ? {} : { bytes: row.bytes }),
    ...(row.worktree.base === '' ? {} : { base: row.worktree.base }),
  }
}

/** The workspace-relative path of a worktree, when it is inside the workspace. */
export function relativeWorktreePath(workspaceRoot: string, path: string): string {
  const rel = relative(workspaceRoot, path)
  return rel === '' ? '.' : rel.split('\\').join('/')
}

/** What a tool call gives this module: which session, and where it is. */
export interface WorktreeSessionContext {
  readonly id: string
  readonly cwd: string
}

/** What the tool definitions need, injected so they hold no state of their own. */
export interface WorktreeToolDeps {
  /**
   * The operations for one workspace.
   *
   * Keyed on the workspace rather than a single instance because a worktree is
   * workspace-scoped: two sessions in different workspaces must not share a
   * registry, and one session that never leaves its workspace must not build one.
   */
  readonly sessions: (workspaceRoot: string) => SessionWorktrees
  /** Read the calling session; `undefined` outside an agent, which is an error to report. */
  readonly sessionOf: (exec: unknown) => WorktreeSessionContext | undefined
  /** Resolve a repository root from a workspace; defaults to the workspace itself. */
  readonly repoRootOf?: (cwd: string) => Promise<string | undefined>
}

const JSON_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
} as const

/**
 * The four worktree tools.
 *
 * Registered from one factory rather than four index.ts blocks so the enter/exit
 * pair cannot drift apart: `exit` has to find what `enter` recorded, and the
 * only way to guarantee that is for both to derive the name from the same
 * function.
 * @param deps - the session reader and the worktree operations.
 * @returns the definitions, in the order they are advertised.
 */
export function worktreeToolDefinitions(deps: WorktreeToolDeps): readonly ToolDefinitionShape[] {
  const contextOf = (exec: unknown): WorktreeSessionContext | { readonly error: string } =>
    deps.sessionOf(exec) ?? { error: 'Worktrees belong to a session, and this call has no agent behind it.' }

  const repoRootFor = async (cwd: string): Promise<string> => (await deps.repoRootOf?.(cwd)) ?? cwd

  return [
    {
      name: 'engineering_worktree_enter',
      description: 'Give this conversation its own copy of the repository under .freecodego/worktrees, so its writes cannot interleave with anyone else\'s. Returns the copy\'s path. Note that a running session\'s working directory is fixed by the Harness, so pass absolute paths under that copy to work in it; a child session created with the copy as its working directory gets the redirect for real. Re-entering returns the copy the session already holds.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          strategy: { type: 'string', enum: ['auto', 'git', 'fast'], description: 'How to make the copy. "git" uses `git worktree add` (default when possible); "fast" copies the tree, which is what works outside a repository.' },
          repo_root: { type: 'string', description: 'Repository to copy. Defaults to this session\'s workspace.' },
          ref: { type: 'string', description: 'Commit or branch to start from. Git strategy only. Defaults to HEAD.' },
        },
      },
      output: JSON_OUTPUT,
      execute: async (args: { readonly strategy?: string; readonly repo_root?: string; readonly ref?: string }, exec: unknown) => {
        const context = contextOf(exec)
        if ('error' in context) return context
        const requested = args?.strategy === 'git' || args?.strategy === 'fast' ? args.strategy : 'auto'
        const outcome = await deps.sessions(context.cwd).enter({
          workspaceRoot: context.cwd,
          sessionId: context.id,
          repoRoot: args?.repo_root ?? await repoRootFor(context.cwd),
          requested,
          ...(args?.ref === undefined ? {} : { ref: args.ref }),
        })
        return {
          ...summarizeWorktree({ worktree: outcome.worktree, owner: 'session', sessionId: context.id, exists: true }),
          reused: outcome.reused,
          isolation: outcome.isolation,
          ...(outcome.fallbackReason === undefined ? {} : { fallbackReason: outcome.fallbackReason }),
        }
      },
      presentCall: () => ({ card: 'generic', title: 'Enter an isolated working copy' }),
    },
    {
      name: 'engineering_worktree_exit',
      description: 'Stop using this conversation\'s isolated working copy. By default the copy and its branch are kept so the change can be reviewed; pass remove: true to discard the copy instead (the branch is still kept).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          remove: { type: 'boolean', description: 'Delete the working copy. Defaults to false, which keeps it for review.' },
        },
      },
      output: JSON_OUTPUT,
      execute: async (args: { readonly remove?: boolean }, exec: unknown) => {
        const context = contextOf(exec)
        if ('error' in context) return context
        const outcome = await deps.sessions(context.cwd).exit({
          sessionId: context.id,
          remove: args?.remove === true,
          repoRoot: await repoRootFor(context.cwd),
        })
        return {
          removed: outcome.removed,
          detail: outcome.detail,
          ...(outcome.worktree === undefined ? {} : { worktree: summarizeWorktree({ worktree: outcome.worktree, owner: 'session', sessionId: context.id, exists: true }) }),
        }
      },
      presentCall: (args: { readonly remove?: boolean }) => ({ card: 'generic', title: args?.remove === true ? 'Discard the isolated copy' : 'Leave the isolated copy in place' }),
    },
    {
      name: 'engineering_worktree_status',
      description: 'Report the working copy this conversation holds: its path, how it was made, whether the directory is still there, and how many bytes it occupies. Use it before and after exiting to see what an isolated copy costs.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: JSON_OUTPUT,
      execute: async (_args: unknown, exec: unknown) => {
        const context = contextOf(exec)
        if ('error' in context) return context
        const sessions = deps.sessions(context.cwd)
        const row = await sessions.status({ sessionId: context.id, workspaceRoot: context.cwd })
        if (row === undefined) return { held: false, note: 'This conversation holds no working copy. engineering_worktree_enter creates one.' }
        return { held: row.worktree.state === 'active', ...summarizeWorktree(row) }
      },
      presentCall: () => ({ card: 'generic', title: 'Isolated working copy' }),
    },
    {
      name: 'engineering_worktree_list',
      description: 'List every worktree registered in this workspace: the team\'s and each conversation\'s, with owner, branch, state and size. Use it to find a copy left behind by an earlier session, or to see total disk held by isolation.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: JSON_OUTPUT,
      execute: async (_args: unknown, exec: unknown) => {
        const context = contextOf(exec)
        if ('error' in context) return context
        const rows = await deps.sessions(context.cwd).list()
        return {
          count: rows.length,
          totalBytes: rows.reduce((total, row) => total + (row.bytes ?? 0), 0),
          missing: rows.filter(row => !row.exists && row.worktree.state === 'active').map(row => row.worktree.path),
          worktrees: rows.map(row => summarizeWorktree(row)),
        }
      },
      presentCall: () => ({ card: 'generic', title: 'Registered worktrees' }),
    },
  ]
}
