/**
 * Claimable shared task board.
 *
 * The board is the team's spine: Claude Code's `Team == TaskList` is one member
 * per owner, `TaskUpdate` moves status, and the owner field is what makes
 * "who is doing this" answerable at all. Without a board, parallel work has no
 * identity — two members either duplicate a task or silently skip it, and the
 * parent has nothing to summarize but prose.
 *
 * Four rules are enforced here rather than hoped for:
 *
 * 1. **Ownership is exclusive.** A task already owned by another member cannot
 *    be claimed; the claim returns who holds it, so the caller can message them
 *    instead of racing them.
 * 2. **Dependencies gate availability.** A task with unfinished `dependsOn` is
 *    not offered by {@link TeamBoard.nextFor}, and claiming it fails loudly.
 * 3. **Availability is ID-ordered.** The lowest open task is next, which is what
 *    makes a shared board deterministic instead of a race for the interesting
 *    task.
 * 4. **Only the owner closes a task.** Completing or failing another member's
 *    task is refused; a board that accepts that cannot be used to audit a run.
 *
 * Two mechanisms come from OMX's team mutation contract, because they are what
 * make a board safe to mutate from more than one process:
 *
 * - **A version on every task.** `claim` can require the version the caller last
 *   read, so two members that both saw `open` do not both win; the loser is told
 *   the task moved instead of silently overwriting a decision. The comparison
 *   runs **inside** the serialized update, against the row as it is at write
 *   time: a version checked before the write is an optimistic read that the
 *   concurrent writer has already invalidated.
 * - **A claim token.** `claim` mints one, and {@link TeamBoard.transition} — the
 *   door the tool surface uses — demands it. A completion that arrives with a
 *   stale token is refused even when the owner matches, which is the case an
 *   owner-only check cannot see: a member that was restarted mid-task.
 *
 * The ownership-only door ({@link TeamBoard.complete} / {@link TeamBoard.fail})
 * is kept because it is the ergonomic path for a single-process team, and it is
 * documented as the weaker one rather than presented as equivalent.
 *
 * Waiting for a person is a state, not a verdict
 * ----------------------------------------------
 * A member that cannot proceed without a human has, until now, had two ways to
 * say so and both were lies: report `failed` (the work is not broken) or stay
 * `claimed` (nobody is told to look). Neither is recoverable either — nothing on
 * the board said what the task was waiting for or on whom. So `needs-review` is a
 * **stored** status ({@link TeamBoard.requestReview}), deliberately unlike
 * `blocked`, which stays derived: a dependency's state is on the board already,
 * while "a person has to decide something" is the one thing the board cannot
 * infer. {@link TeamBoard.resume} puts the task back in the owner's hands without
 * releasing it, and {@link TeamBoard.rerun} reopens a failure under the same id.
 *
 * Every status change is appended to a per-task {@link TeamTaskTransition} list.
 * The board previously kept only the latest `note`, so a task that went open →
 * claimed → needs-review → claimed → failed read as "failed, with this reason",
 * and the reason the human was asked in the first place was gone. The ledger is
 * written by {@link TeamBoard.mutate} rather than by each transition, so a future
 * transition cannot forget it.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/team/board
 */

import { TEAM_NOTE_LIMIT, TeamJsonStore, boundedTeamText, teamId } from './state.ts'

/**
 * Lifecycle of one board task.
 *
 * `blocked` is derived, never set by a caller: it means a dependency failed, and
 * its cause is on the board. `needs-review` is the opposite — stored, and set only
 * by a caller, because "a person has to decide something" is not inferable from
 * anything else the board holds. Neither is terminal: `done`, `failed` and
 * `cancelled` are.
 */
/**
 * The lifecycle values this build knows, as a value rather than only as a type.
 *
 * The one reader that has to consult them is the file boundary: a board file is
 * untyped input, and a status nobody recognises used to load as a real task that
 * belonged to no bucket. A vocabulary a boundary can read is what makes that
 * checkable; `typeof … [number]` keeps the type and the value from drifting.
 */
export const TEAM_TASK_STATUSES = ['open', 'claimed', 'needs-review', 'blocked', 'done', 'failed', 'cancelled'] as const

export type TeamTaskStatus = typeof TEAM_TASK_STATUSES[number]

/** The same vocabulary for the reader that takes untyped input. */
export const TEAM_TASK_STATUS_NAMES: ReadonlySet<string> = new Set(TEAM_TASK_STATUSES)

/**
 * The statuses a board file may store.
 *
 * Written by hand rather than derived from {@link TEAM_TASK_STATUSES} minus
 * `blocked`, deliberately: a list computed from the other list cannot disagree with
 * it, and disagreement is the only thing this list is here to detect. `blocked` is
 * absent because it is derived — the type comment above says so and
 * {@link TeamBoard.blocked} computes it — so a file that stores it is storing
 * something this build cannot read.
 *
 * The detection that sentence describes is `team-board.spec.ts`'s "covers every
 * status exactly once across the stored and derived halves", and it was written
 * later than this comment. Until it existed the list was hand-written for a reason
 * nothing checked, and the drift it warns about is the quiet kind: a status added
 * to the full vocabulary and not to this one is settable in memory, `isStoredStatus`
 * does not know it, and `parseBoard` repairs it to `open` on the next read while
 * writing a ledger entry that blames the file.
 */
export const TEAM_STORED_TASK_STATUSES = ['open', 'claimed', 'needs-review', 'done', 'failed', 'cancelled'] as const

/** Statuses computed from the board rather than stored on a task. */
export const TEAM_DERIVED_TASK_STATUSES = ['blocked'] as const

const TEAM_STORED_TASK_STATUS_NAMES: ReadonlySet<string> = new Set(TEAM_STORED_TASK_STATUSES)

/**
 * Whether a status read from a board file is one this build may store.
 *
 * A predicate rather than a bare `TEAM_TASK_STATUS_NAMES.has`, because the else
 * branch is what the caller needs to name: narrowing to the storable half leaves the
 * unreachable half as `'blocked'` for the compiler, so a repaired row cannot be
 * written with a status this build would refuse to store.
 */
export function isStoredStatus(value: string): value is Exclude<TeamTaskStatus, 'blocked'> {
  return TEAM_STORED_TASK_STATUS_NAMES.has(value)
}

/**
 * The statuses that are an outcome rather than a state of work.
 *
 * Also a value, for the same reason: the sentence "Neither is terminal: `done`,
 * `failed` and `cancelled` are" lived in the comment above while the code compared
 * the three of them by hand in one place and forgot to in another. `claim` and
 * `release` both read this list now, so a door added later cannot quietly omit the
 * check — though a missing call is still a missing call, which is why `release`
 * needed its own fix.
 */
export const TEAM_TERMINAL_TASK_STATUSES = ['done', 'failed', 'cancelled'] as const

const TEAM_TERMINAL_TASK_STATUS_NAMES: ReadonlySet<string> = new Set(TEAM_TERMINAL_TASK_STATUSES)

export interface TeamTask {
  /** Board-local identity, also the availability order (`t1` < `t2` < `t10`). */
  readonly id: string
  readonly title: string
  readonly detail: string
  readonly status: TeamTaskStatus
  readonly owner?: string | undefined
  readonly createdBy: string
  readonly createdAt: number
  readonly updatedAt: number
  /**
   * Monotonic revision, bumped by every mutation. A caller that read version N
   * may pass `expectedVersion: N` to claim, and loses cleanly when the task has
   * moved on — the compare-and-set that stops two readers from both winning.
   */
  readonly version: number
  /**
   * Minted by `claim` and required by {@link TeamBoard.transition}. It is the
   * evidence that the closing call comes from the same claim, not merely from a
   * member that happens to share the owner's name after a restart.
   */
  readonly claimToken?: string | undefined
  /** Approval decisions recorded against this task, newest last. */
  readonly approvals: readonly TeamTaskApproval[]
  /** Tasks that must be `done` before this one is offered. */
  readonly dependsOn: readonly string[]
  /** Paths or notes a member produced, so a reviewer can find the work. */
  readonly artifacts: readonly string[]
  /** Claim attempts, which is how a thrashing member becomes visible. */
  readonly attempts: number
  readonly note?: string | undefined
  /**
   * Who or what the task is waiting on, while its status is `needs-review`.
   * Cleared by {@link TeamBoard.mutate} on the way out of that status.
   */
  readonly waitingOn?: string | undefined
  /** When it started waiting, so a stale wait is visible as an age. */
  readonly waitingSince?: number | undefined
  /**
   * Every status change this task has been through, oldest first, capped.
   *
   * The reason a task was parked for a review has to outlive the review: `note`
   * holds only the latest one, and the interesting question later is usually why
   * the *previous* step happened.
   */
  readonly history: readonly TeamTaskTransition[]
}

/** One recorded status change. */
export interface TeamTaskTransition {
  readonly at: number
  /** Who asked for it, or `board` when the change had no caller behind it. */
  readonly by: string
  readonly from: TeamTaskStatus
  readonly to: TeamTaskStatus
  readonly note?: string | undefined
}

/** One approval decision, stored on the task so the board is the audit record. */
export interface TeamTaskApproval {
  readonly by: string
  readonly decision: 'approved' | 'rejected'
  readonly note: string
  readonly at: number
}

export interface TeamBoardDocument {
  readonly version: 1
  readonly teamId: string
  readonly counter: number
  readonly tasks: readonly TeamTask[]
}

export interface TeamBoardSummary {
  readonly total: number
  readonly open: number
  readonly claimed: number
  readonly blocked: number
  readonly done: number
  readonly failed: number
  readonly cancelled: number
  /**
   * Tasks parked on a human decision. Counted apart from every other bucket on
   * purpose: folding them into `claimed` hides a stalled team, and folding them
   * into `failed` blames work that is not broken.
   */
  readonly needsReview: number
  /** The parked tasks themselves, so a reader can act without listing the board. */
  readonly waiting: readonly { readonly id: string; readonly on: string; readonly since: number }[]
  /** Claimed-or-done counts per member, so a lopsided board is visible. */
  readonly byOwner: Readonly<Record<string, { readonly claimed: number; readonly done: number }>>
}

/** How many transitions per task are kept. Bounded like `approvals`. */
const HISTORY_LIMIT = 20

/**
 * How many parked tasks {@link TeamBoard.summary} lists.
 *
 * A display cap, and named so it cannot be read as anything else: the count of
 * parked tasks used to be the length of this window, so a team with twenty-five of
 * them reported twenty — the cap answering a question nobody asked it.
 */
const WAITING_LIMIT = 20

/**
 * Why a write to an already-closed task is refused.
 *
 * One sentence for the four closing doors, because they are one rule: a task that
 * has an outcome is the record of what happened, and a record a later call can
 * rewrite is not a record. `release` carries its own sentence, because the door it
 * refuses is `rerun` rather than a second close.
 */
const CLOSED_TASK_REASON = 'a closed task is a record, not work in progress'

/** Sorting a board-local id: `t2` before `t10`, which a string sort gets wrong. */
export function compareTeamTaskIds(left: string, right: string): number {
  const numeric = (value: string): number => Number.parseInt(value.replace(/^t/u, ''), 10) || 0
  return numeric(left) - numeric(right) || left.localeCompare(right)
}

/**
 * A row as it was read from disk, before this build has vouched for any field.
 *
 * Only the three fields a row needs in order to *be* a row are narrowed here.
 * Everything else stays `unknown`, including the fields {@link TeamTask} declares
 * as required — because declaring a disk row a `TeamTask` was a promise the file
 * cannot keep, and three separate defects arrived through that gap: a stored
 * `'blocked'` no code path can produce, `undefined` timestamps that the type says
 * are numbers, and a `claimToken` written as a number, which pins the task (the
 * token door compares against the string the tool schema asks for, so nobody can
 * close it that way). From this build on the stored type is built field by field
 * at the boundary, and the `: TeamTask` annotation on that construction turns
 * "a field was added to `TeamTask` and not handled here" into a compile error.
 */
interface RawTask extends Record<string, unknown> {
  readonly id: string
  readonly title: string
  readonly status: string
}

/**
 * The spelling a file used, kept as the ledger wrote it.
 *
 * A repair records what was *there*, not a status this build recognises: the
 * value is the evidence of what the file said. `TeamTaskTransition.from` is typed
 * as a status and a transition written by a real move does carry one; the type
 * cannot tell the two apart, which is why the ledger is documented as an audit
 * record rather than a status history.
 */
function asRecorded(spelling: string): TeamTaskStatus {
  return spelling as TeamTaskStatus
}

function isTask(value: unknown): value is RawTask {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const task = value as Record<string, unknown>
  return typeof task.id === 'string' && typeof task.title === 'string' && typeof task.status === 'string'
}

function isTransition(value: unknown): value is TeamTaskTransition {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Partial<TeamTaskTransition>
  return typeof entry.at === 'number' && typeof entry.by === 'string'
    && typeof entry.from === 'string' && typeof entry.to === 'string'
}

/**
 * Whether an entry a file stored under `approvals` is a decision.
 *
 * The shape is the one `approve` writes, checked field by field for the reason
 * the module header gives: a declared field that passes through on an
 * `Array.isArray` alone is a promise the file cannot keep, and this was the last
 * one. A `decision` outside the two verdicts is rejected rather than narrowed —
 * `TeamTaskApproval.decision` is the pair the board is asked about, and a third
 * spelling is a fact about a different build, not a decision with a new name.
 */
function isApproval(value: unknown): value is TeamTaskApproval {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Partial<TeamTaskApproval>
  return typeof entry.by === 'string' && typeof entry.note === 'string' && typeof entry.at === 'number'
    && (entry.decision === 'approved' || entry.decision === 'rejected')
}

/**
 * Settle one id per row, unique on this board, and the counter that follows it.
 *
 * Two rows can share an id because board ids come from a counter: the build
 * before `create`'s reservation fix advanced it by the number of *kept* tasks, so
 * a dropped entry handed its id to the next call. That board is on disk, and
 * every door but `create` matches rows by id — so one `claim` moved both rows,
 * one `transition` closed both, and `byOwner` reported a member holding two tasks
 * after a single claim. `create` refuses to add a third row with the id; this is
 * the pair already there.
 *
 * Reassigned rather than dropped, for the reason `create` states one door over:
 * two rows with one id are two tasks, and losing the work is not recoverable. The
 * **first** row keeps the id, because `find` already resolved every reference to
 * it that way — so a dependency naming the id still names the same task.
 *
 * The counter is raised to the high-water mark of the ids in the file, because a
 * counter that fell behind them is the other half of the same defect and the
 * quieter one: `create` mints `counter + n`, an id already in use is skipped
 * *silently* while the counter still advances, and the caller's plan comes back
 * reordered with nothing thrown and nothing named.
 */
function assignIds(rows: readonly RawTask[], declaredCounter: number): { readonly ids: readonly string[]; readonly counter: number } {
  const numeric = (value: string): number => {
    const parsed = Number.parseInt(value.replace(/^t/u, ''), 10)
    return Number.isFinite(parsed) ? parsed : 0
  }
  let highWater = Number.isFinite(declaredCounter) ? Math.max(0, Math.floor(declaredCounter)) : 0
  for (const row of rows) highWater = Math.max(highWater, numeric(row.id))
  const taken = new Set<string>()
  const ids: string[] = []
  for (const row of rows) {
    // An empty id is not an identity either, and it is the one an interrupted
    // writer is likeliest to leave: `isTask` only asks for a string.
    let id = row.id
    if (id === '' || taken.has(id)) id = `t${++highWater}`
    taken.add(id)
    ids.push(id)
  }
  return { ids, counter: highWater }
}

function parseBoard(teamIdValue: string): (input: unknown) => TeamBoardDocument | undefined {
  return (input) => {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
    const document = input as Partial<TeamBoardDocument>
    if (!Array.isArray(document.tasks)) return undefined
    const rows = document.tasks.filter(isTask)
    // Identity is settled before any row is built, because a field that names a
    // task cannot be read correctly until the names are unique.
    const assigned = assignIds(rows, typeof document.counter === 'number' ? document.counter : 0)
    const built = rows.map((task, index): TeamTask => {
      // The status is the one field a file can get wrong in a way that silently
      // breaks the panel: an unrecognised spelling used to load as a real task that
      // belonged to no bucket, so `total` exceeded the sum of the buckets — the only
      // equation the panel checks against itself. Every other field here is repaired
      // toward a safe default; this one is repaired toward the *recoverable* side
      // (back into the open pool, where any member may claim it), and the repair is
      // recorded in the ledger so a reader looking at status changes sees both the
      // spelling that was there and what it became.
      //
      // A stored `blocked` is repaired too, and that is the same decision rather than
      // a second one: `blocked` is derived from a failed dependency, so a file that
      // stores it is either stale or foreign, and `blocked()` recomputes it the
      // moment the dependency is retried.
      const history = Array.isArray(task.history) ? task.history.filter(isTransition).slice(-HISTORY_LIMIT) : []
      const storable = isStoredStatus(task.status)
      // The repairs this read makes, recorded in the ledger beside the status one
      // below. A reassignment is not a move between statuses, and it is logged
      // with the row's own status on both ends for that reason: the ledger is the
      // audit record of what the file said, which is the property a reader needs
      // here — that an id on this board was not the one written.
      const repairs: TeamTaskTransition[] = (assigned.ids[index] ?? task.id) === task.id ? [] : [{
        at: Date.now(),
        by: 'board',
        from: asRecorded(task.status),
        to: asRecorded(task.status),
        note: `the id "${task.id}" was already on this board; this task is "${assigned.ids[index]}" from here on`,
      }]
      return {
        // Unknown keys travel with the row: a field a later build wrote is not
        // this build's to drop on the way through.
        ...task,
        id: assigned.ids[index] ?? task.id,
        title: task.title,
        // An absent detail is a task with no detail; `''` is already what
        // `team/roles.ts` means by it.
        detail: typeof task.detail === 'string' ? boundedTeamText(task.detail) : '',
        status: isStoredStatus(task.status) ? task.status : 'open' as const,
        // JSON omits an `undefined` owner. Restore that explicit in-memory value
        // so readers of an open task do not need to distinguish a fresh document
        // from one that was claimed and then released.
        owner: typeof task.owner === 'string' ? task.owner : undefined,
        // No caller wrote this row, so the ledger's word for it is `board`.
        createdBy: typeof task.createdBy === 'string' ? task.createdBy : 'board',
        // Epoch rather than `Date.now()`: stable, and it does not claim the task
        // was created at the moment it happened to be read. The cost is written
        // down rather than hidden — a parked row with no recorded date reports a
        // 1970 wait, which is a visible "unknown" instead of a false "just now".
        createdAt: typeof task.createdAt === 'number' ? task.createdAt : 0,
        updatedAt: typeof task.updatedAt === 'number' ? task.updatedAt : 0,
        // A board written before the CAS fields existed reads as version 0 with no
        // approvals; treating a missing version as "any version" would defeat the
        // check exactly once, on the upgrade turn.
        version: typeof task.version === 'number' ? task.version : 0,
        // A non-string token is dropped, not kept. Kept, it pins the task: the
        // token door compares against the string the tool schema asks for, so a
        // row storing `12345` can never be closed through it. Dropped, the owner
        // can still finish the work — the recoverable direction.
        claimToken: typeof task.claimToken === 'string' ? task.claimToken : undefined,
        // Bounded and shape-checked like everything else here: `engineering_team_board`
        // and `engineering_team_recover` both hand this list to the model, so an
        // entry a file invented arrives as a decision somebody made.
        approvals: Array.isArray(task.approvals)
          ? task.approvals.filter(isApproval).map(entry => ({
            by: boundedTeamText(entry.by, 120),
            decision: entry.decision,
            note: boundedTeamText(entry.note, TEAM_NOTE_LIMIT),
            at: entry.at,
          })).slice(-20)
          : [],
        dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.filter((id): id is string => typeof id === 'string') : [],
        // The same bound and cap `transition` applies on the way in, so a file
        // cannot turn one task's artifact list into a request-sized payload.
        artifacts: Array.isArray(task.artifacts)
          ? task.artifacts.filter((id): id is string => typeof id === 'string').map(artifact => boundedTeamText(artifact, 500)).filter(artifact => artifact !== '').slice(0, 20)
          : [],
        attempts: typeof task.attempts === 'number' ? task.attempts : 0,
        note: typeof task.note === 'string' ? boundedTeamText(task.note, TEAM_NOTE_LIMIT) : undefined,
        // A board written before the ledger existed reads as an empty one rather
        // than as a task with an unreadable history; the detail a reader loses is
        // bounded by the fact that nothing older than the file matters.
        history: storable ? [...history, ...repairs].slice(-HISTORY_LIMIT) : [...history, ...repairs, {
          at: Date.now(),
          by: 'board',
          from: asRecorded(task.status),
          to: 'open' as const,
          note: `stored status "${task.status}" is not one this build knows; the task was returned to the open pool`,
        }].slice(-HISTORY_LIMIT),
        waitingOn: typeof task.waitingOn === 'string' ? task.waitingOn : undefined,
        waitingSince: typeof task.waitingSince === 'number' ? task.waitingSince : undefined,
      }
    })
    // A dependency is kept only while the row it names is on this board. One that
    // names nothing is not a task that waits — it is a task that never runs, and
    // this is the last door it can arrive through: `create` refuses it (see
    // `team-board.spec.ts`), a row `isTask` dropped used to leave it behind, and a
    // self-reference is satisfiable by no completion at all. Left in place the
    // task is in neither report: `nextFor` never offers it and `blocked()` names
    // only a *failed* dependency, which this one can never become.
    const known = new Set(built.map(task => task.id))
    const tasks = built.map((task): TeamTask => {
      const unsatisfiable = task.dependsOn.filter(dependency => dependency === task.id || !known.has(dependency))
      if (unsatisfiable.length === 0) return task
      return {
        ...task,
        dependsOn: task.dependsOn.filter(dependency => dependency !== task.id && known.has(dependency)),
        history: [...task.history, {
          at: Date.now(),
          by: 'board',
          from: task.status,
          to: task.status,
          note: `a dependency this board cannot satisfy — "${unsatisfiable.join('", "')}" names this task itself or no row at all; the entry was dropped so the task is available instead of never running`,
        }].slice(-HISTORY_LIMIT),
      }
    })
    return {
      version: 1,
      teamId: typeof document.teamId === 'string' ? document.teamId : teamIdValue,
      counter: assigned.counter,
      tasks,
    }
  }
}

export class TeamBoard {
  private readonly store: TeamJsonStore<TeamBoardDocument>

  constructor(teamIdValue: string, filePath: string) {
    this.store = new TeamJsonStore<TeamBoardDocument>(filePath, () => ({ version: 1, teamId: teamIdValue, counter: 0, tasks: [] }), parseBoard(teamIdValue))
  }

  /** All tasks, ID-ordered. */
  async list(): Promise<readonly TeamTask[]> {
    return [...(await this.store.read()).tasks].sort((left, right) => compareTeamTaskIds(left.id, right.id))
  }

  async get(id: string): Promise<TeamTask | undefined> {
    return (await this.store.read()).tasks.find(task => task.id === id)
  }

  /**
   * Add tasks in the order given, returning them with their assigned ids.
   *
   * A `dependsOn` entry may name a task created in the same call by its 1-based
   * position (`"$1"`), because a caller laying out a plan knows the order it
   * just wrote and should not have to create, read back, then patch.
   */
  async create(input: {
    readonly createdBy: string
    readonly tasks: readonly { readonly title: string; readonly detail?: string; readonly dependsOn?: readonly string[] }[]
  }): Promise<readonly TeamTask[]> {
    const now = Date.now()
    const created: TeamTask[] = []
    await this.store.update((current) => {
      const tasks = [...current.tasks]
      // One id is reserved per entry in the call, including entries dropped just
      // below. Advancing the counter by the number of *kept* tasks instead let a
      // dropped entry hand its id to the next call: creating `[{title: ''},
      // {title: 'kept'}]` produced `t2`, and the next `create` produced `t2`
      // again, so two tasks shared one id and `mutate` rewrote both.
      const localIds = input.tasks.map((_entry, index) => `t${String(current.counter + index + 1)}`)
      for (const [index, entry] of input.tasks.entries()) {
        const title = boundedTeamText(entry.title, 300)
        if (title === '') continue
        const id = localIds[index] ?? teamId('t')
        // A board written by the buggy reservation still exists on disk; refuse
        // to compound the damage rather than pushing a second task with that id.
        if (tasks.some(task => task.id === id)) continue
        const dependsOn = (entry.dependsOn ?? []).map((dependency) => {
          const local = /^\$(\d+)$/u.exec(dependency)
          return local === null ? dependency : localIds[Number(local[1]) - 1] ?? dependency
        }).filter(dependency => dependency !== id)
        const task: TeamTask = {
          id,
          title,
          detail: boundedTeamText(entry.detail),
          status: 'open',
          createdBy: input.createdBy,
          createdAt: now,
          updatedAt: now,
          version: 0,
          approvals: [],
          dependsOn,
          artifacts: [],
          attempts: 0,
          history: [],
        }
        tasks.push(task)
        created.push(task)
      }
      // A dependency that names nothing is not a task that waits — it is a task
      // that never runs. `blocked()` does not report it (its cause is a *failed*
      // dependency, and a missing one never fails), so the panel counts it as
      // available while `nextFor` never offers it, and only a direct `claim` ever
      // says why. Refusing here rather than dropping the entry keeps the caller's
      // plan intact: `update` writes only after this mutation returns, so a throw
      // leaves the batch uncreated instead of half-created and silently reordered.
      // Every id this call could produce was reserved above, so a `$N` naming a
      // dropped entry is caught by the same check.
      const known = new Set(tasks.map(task => task.id))
      for (const task of created) {
        const missing = task.dependsOn.find(dependency => !known.has(dependency))
        if (missing !== undefined) {
          throw new Error(`task "${task.id}" depends on "${missing}", which is not on this board`)
        }
      }
      return { ...current, counter: current.counter + input.tasks.length, tasks }
    })
    return created
  }

  /**
   * Claim a task for `owner`.
   *
   * Refuses when another member holds it (naming them) or when its dependencies
   * are not done yet (naming them), because "someone else has that" and "that
   * is not ready" are different problems with different fixes.
   */
  async claim(id: string, owner: string, options: { readonly expectedVersion?: number } = {}): Promise<TeamTask> {
    // Re-claiming by the same owner is idempotent for the status but mints a new
    // token: the new token is the live claim, and the old one stops working.
    const claimToken = teamId('c')
    return await this.mutate(
      id,
      current => ({ status: 'claimed' as const, owner, attempts: current.attempts + 1, claimToken }),
      // Every precondition is re-checked against the *live* row inside the
      // serialized update. Reading the board, validating, and then writing in a
      // second step is not a compare-and-set: two claims that both read version 0
      // both pass the check, and the second silently takes the task from the
      // first while the first is told it won.
      (current, tasks) => {
        if (TEAM_TERMINAL_TASK_STATUS_NAMES.has(current.status)) {
          throw new Error(`task "${id}" is already ${current.status}`)
        }
        // Re-claiming a parked task would mint a fresh token and hide the wait
        // behind an ordinary claim; the resume path is what records that a person
        // answered.
        if (current.status === 'needs-review') {
          throw new Error(`task "${id}" is waiting on ${current.waitingOn ?? 'a reviewer'}; its owner resumes it once that is settled`)
        }
        if (options.expectedVersion !== undefined && options.expectedVersion !== current.version) {
          throw new Error(`task "${id}" moved to version ${current.version} (expected ${options.expectedVersion}); re-read it and retry`)
        }
        if (current.owner !== undefined && current.owner !== owner) {
          throw new Error(`task "${id}" is claimed by "${current.owner}"`)
        }
        const unmet = current.dependsOn.filter(dependency => tasks.find(task => task.id === dependency)?.status !== 'done')
        if (unmet.length > 0) throw new Error(`task "${id}" is blocked by ${unmet.join(', ')}`)
      },
      owner,
    )
  }

  /**
   * Park a claimed task until a person decides something.
   *
   * The point of the status is that it is neither a failure nor progress. A
   * member that needs a human either reported `failed` — which is a claim about
   * the work, not about the blocker, and which turns every dependent into a
   * blocked task — or said nothing and stayed `claimed`, which is invisible. This
   * records the state, who is being waited on, and since when, and leaves the
   * claim and its token with the owner: the member that asked the question is the
   * one that should pick the answer up.
   *
   * The token is checked when presented, not demanded — the same rule as
   * {@link TeamBoard.release}, and for the same reason: parking work is the
   * recoverable direction, so a stale writer can only be accepted or refused,
   * never used to assert an outcome.
   */
  async requestReview(id: string, owner: string, input: {
    readonly note: string
    readonly waitingOn?: string
    readonly claimToken?: string
  }): Promise<TeamTask> {
    return await this.mutate(
      id,
      () => ({
        status: 'needs-review' as const,
        note: boundedTeamText(input.note, TEAM_NOTE_LIMIT),
        waitingOn: boundedTeamText(input.waitingOn ?? 'a human reviewer', 120),
        waitingSince: Date.now(),
      }),
      (current) => {
        if (current.status !== 'claimed') throw new Error(`task "${id}" is ${current.status}; only a claimed task can wait for a review`)
        this.assertOwned(current, owner)
        if (input.claimToken !== undefined) this.requireToken(current, input.claimToken, 'request a review')
      },
      owner,
    )
  }

  /**
   * Take a parked task back, once whatever it waited on is settled.
   *
   * Resuming rather than re-claiming is what keeps the waiting visible in the
   * ledger, and it cannot be done by anyone but the owner: the task never left
   * their hands, so handing it to someone else is a release first.
   */
  async resume(id: string, owner: string, options: { readonly claimToken?: string; readonly note?: string } = {}): Promise<TeamTask> {
    return await this.mutate(
      id,
      () => ({
        status: 'claimed' as const,
        ...(options.note === undefined ? {} : { note: boundedTeamText(options.note, TEAM_NOTE_LIMIT) }),
      }),
      (current) => {
        if (current.status !== 'needs-review') throw new Error(`task "${id}" is ${current.status}; only a task waiting for a review is resumed`)
        this.assertOwned(current, owner)
        if (options.claimToken !== undefined) this.requireToken(current, options.claimToken, 'resume')
      },
      owner,
    )
  }

  /**
   * Reopen a failed or cancelled task under the same id.
   *
   * `create` was the only way back, and it lost the link between the attempt that
   * failed and the one that replaces it — including the attempt count that makes a
   * task thrashing visible. No ownership check: the reason to rerun a task is
   * usually that the member that owned it is gone, so the caller is the parent.
   * The failure stays in the history.
   */
  async rerun(id: string, by: string, note = ''): Promise<TeamTask> {
    return await this.mutate(
      id,
      () => ({
        status: 'open' as const,
        owner: undefined,
        claimToken: undefined,
        ...(note === '' ? {} : { note: boundedTeamText(note, TEAM_NOTE_LIMIT) }),
      }),
      (current) => {
        if (current.status !== 'failed' && current.status !== 'cancelled') {
          throw new Error(`task "${id}" is ${current.status}; only a failed or cancelled task is rerun`)
        }
      },
      by,
    )
  }

  /**
   * Give a claim back without closing the task.
   *
   * A token is *checked when presented* but not demanded, unlike closing a task
   * (see {@link TeamBoard.transition}). Releasing moves work back into the pool,
   * which is the recoverable direction: the ownership check above already refuses
   * a release from a member who no longer owns the task, so a stale token can only
   * be accepted or rejected, never used to assert a false outcome.
   */
  async release(id: string, owner: string, claimToken?: string): Promise<TeamTask> {
    return await this.mutate(
      id,
      current => ({ status: 'open' as const, owner: undefined, claimToken: undefined, attempts: current.attempts }),
      (current) => {
        // The status first, and before the ownership fence: an outcome is more
        // fundamental than a name. The fence is not enough on its own because
        // closing a task deliberately leaves the owner on the row — so the member
        // that has just finished the work still passes it, and releasing a `done`
        // task used to rewrite it to `open`, clear the owner, and put finished work
        // back in the pool (which also made a task depending on it claimable again).
        // The refusal names the door that *is* open for a closed task.
        this.refuseClosed(current, 'a closed task has no claim to release; rerun reopens a failed or cancelled one')
        this.assertOwned(current, owner)
        if (claimToken !== undefined) this.requireToken(current, claimToken, 'release')
      },
      owner,
    )
  }

  /**
   * Close a task through the claim-token door.
   *
   * This is the strict path: the token must match the live claim, so a restarted
   * member cannot close work it no longer holds even though its owner name is
   * unchanged. The team tool surface uses this; `complete`/`fail` below are the
   * ownership-only convenience for a single-process team.
   */
  async transition(id: string, owner: string, input: {
    readonly status: 'done' | 'failed' | 'cancelled'
    readonly claimToken?: string
    readonly note?: string
    readonly artifacts?: readonly string[]
  }): Promise<TeamTask> {
    return await this.mutate(
      id,
      current => ({
        status: input.status,
        claimToken: undefined,
        note: boundedTeamText(input.note, TEAM_NOTE_LIMIT),
        ...(input.status === 'done'
          ? { artifacts: [...current.artifacts, ...(input.artifacts ?? []).map(artifact => boundedTeamText(artifact, 500))].filter(artifact => artifact !== '').slice(0, 20) }
          : {}),
      }),
      (current) => {
        this.refuseClosed(current, CLOSED_TASK_REASON)
        this.assertOwned(current, owner)
        this.requireToken(current, input.claimToken, `transition to ${input.status}`)
      },
      owner,
    )
  }

  private requireToken(task: TeamTask, provided: string | undefined, action: string): void {
    if (task.claimToken === undefined) return
    if (provided === undefined) throw new Error(`task "${task.id}" was claimed with a token; ${action} must present it (the board reports the token to the claimer)`)
    if (provided !== task.claimToken) throw new Error(`task "${task.id}" no longer holds that claim token; ${action} refused so a stale writer cannot close someone else's work`)
  }

  /** Record an approval decision against a task, without changing its status. */
  async approve(id: string, by: string, decision: 'approved' | 'rejected', note = ''): Promise<TeamTask> {
    return await this.mutate(id, current => ({
      approvals: [...current.approvals, { by: boundedTeamText(by, 120), decision, note: boundedTeamText(note, TEAM_NOTE_LIMIT), at: Date.now() }].slice(-20),
    }), undefined, by)
  }

  async complete(id: string, owner: string, input: { readonly note?: string; readonly artifacts?: readonly string[] } = {}): Promise<TeamTask> {
    return await this.mutate(
      id,
      current => ({
        status: 'done' as const,
        note: boundedTeamText(input.note, TEAM_NOTE_LIMIT),
        artifacts: [...current.artifacts, ...(input.artifacts ?? []).map(artifact => boundedTeamText(artifact, 500))].filter(artifact => artifact !== '').slice(0, 20),
      }),
      (current) => {
        this.refuseClosed(current, CLOSED_TASK_REASON)
        this.assertOwned(current, owner)
      },
      owner,
    )
  }

  async fail(id: string, owner: string, note: string): Promise<TeamTask> {
    return await this.mutate(
      id,
      () => ({ status: 'failed' as const, note: boundedTeamText(note, TEAM_NOTE_LIMIT) }),
      (current) => {
        // Closing a failed task again is how a board loses the difference between
        // "it broke" and "it broke later": the second call overwrites the note that
        // says what happened, and the ledger entry that would explain it is the one
        // `mutate` does not write, because the status did not change.
        this.refuseClosed(current, CLOSED_TASK_REASON)
        this.assertOwned(current, owner)
      },
      owner,
    )
  }

  async cancel(id: string, note?: string): Promise<TeamTask> {
    return await this.mutate(
      id,
      () => ({ status: 'cancelled' as const, note: boundedTeamText(note, TEAM_NOTE_LIMIT) }),
      (current) => { this.refuseClosed(current, CLOSED_TASK_REASON) },
    )
  }

  /**
   * The lowest-ID task `owner` may start right now.
   *
   * A member calls this instead of picking: ID order is what keeps a shared
   * board from turning into a race for the pleasant work, and the dependency
   * check is the same one `claim` applies.
   */
  async nextFor(owner: string): Promise<TeamTask | undefined> {
    const tasks = await this.list()
    const done = new Set(tasks.filter(task => task.status === 'done').map(task => task.id))
    // A parked task is not next for anyone, its own owner included: it is only
    // 'claimed' again once the owner resumes it, which is a decision rather than
    // an availability, and only the `claimed` branch below can offer it.
    return tasks.find(task => (task.status === 'open' || (task.status === 'claimed' && task.owner === owner))
      && task.dependsOn.every(dependency => done.has(dependency)))
  }

  /**
   * Tasks that can never run because something they depend on failed, plus the
   * failed task that caused it. Computed, never stored: a stored `blocked` bit
   * goes stale the moment a failed dependency is retried.
   */
  async blocked(): Promise<readonly { readonly task: TeamTask; readonly cause: string }[]> {
    const tasks = await this.list()
    const failed = new Map(tasks.filter(task => task.status === 'failed' || task.status === 'cancelled').map(task => [task.id, task]))
    const blocked: { task: TeamTask; cause: string }[] = []
    for (const task of tasks) {
      if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') continue
      const cause = task.dependsOn.find(dependency => failed.has(dependency))
      if (cause !== undefined) blocked.push({ task, cause })
    }
    return blocked
  }

  async summary(): Promise<TeamBoardSummary> {
    const tasks = await this.list()
    const blocked = new Set((await this.blocked()).map(entry => entry.task.id))
    const byOwner: Record<string, { claimed: number; done: number }> = {}
    for (const task of tasks) {
      if (task.owner === undefined) continue
      const entry = byOwner[task.owner] ?? { claimed: 0, done: 0 }
      if (task.status === 'done') entry.done += 1
      else if (task.status === 'claimed') entry.claimed += 1
      byOwner[task.owner] = entry
    }
    // One pass, and each task enters exactly one bucket. The blocked view used to be
    // *added* to the stored status, so a task waiting on a failed dependency was
    // counted twice — once where it sat and once as blocked. `total` is the sum of the
    // buckets, which is the only equation the panel checks against itself, and a
    // bucket that overlaps another makes that equation unfalsifiable rather than
    // visibly wrong, which is worse.
    const counts: Record<TeamTaskStatus, number> = { open: 0, claimed: 0, 'needs-review': 0, blocked: 0, done: 0, failed: 0, cancelled: 0 }
    const waiting: { readonly id: string; readonly on: string; readonly since: number }[] = []
    for (const task of tasks) {
      counts[blocked.has(task.id) ? 'blocked' : task.status] += 1
      if (task.status === 'needs-review' && waiting.length < WAITING_LIMIT) {
        waiting.push({ id: task.id, on: task.waitingOn ?? 'a human reviewer', since: task.waitingSince ?? task.updatedAt })
      }
    }
    return {
      total: tasks.length,
      open: counts.open,
      claimed: counts.claimed,
      // The count of parked tasks, not the length of the window that lists them: the
      // window is capped so a report stays readable, and reading the cap as the count
      // made twenty-five parked tasks report twenty.
      needsReview: counts['needs-review'],
      // A task with an unmet dependency is reported as blocked even while it is
      // still nominally open, because that is the state the reader must act on.
      blocked: counts.blocked,
      done: counts.done,
      failed: counts.failed,
      cancelled: counts.cancelled,
      waiting,
      byOwner,
    }
  }

  private assertOwned(task: TeamTask, owner: string): void {
    if (task.owner !== owner) throw new Error(`task "${task.id}" is owned by "${task.owner ?? 'nobody'}", not "${owner}"`)
  }

  /**
   * Refuse a write to a task that already has an outcome.
   *
   * Every door that closes a task asks this first, so the four of them cannot
   * disagree about what "already closed" means. It runs before the ownership and
   * token checks because those answer "may this caller act" — a question that only
   * makes sense once "is there anything left to act on" has an answer.
   *
   * `rerun` deliberately does not call it: reopening a failed or cancelled task is
   * the one legitimate write to a closed row, and it is a separate door for exactly
   * that reason.
   */
  private refuseClosed(task: TeamTask, because: string): void {
    if (TEAM_TERMINAL_TASK_STATUS_NAMES.has(task.status)) {
      throw new Error(`task "${task.id}" is ${task.status}; ${because}`)
    }
  }

  /**
   * The only writer.
   *
   * `guard` runs inside the serialized update against the freshly read row, and a
   * refusal throws out of the update so nothing is written. Preconditions belong
   * here rather than in the caller: a check performed on a value read one step
   * earlier is an optimistic check the next writer can already have invalidated.
   */
  private async mutate(
    id: string,
    patch: (current: TeamTask) => Partial<TeamTask>,
    guard?: (current: TeamTask, tasks: readonly TeamTask[]) => void,
    actor = 'board',
  ): Promise<TeamTask> {
    const now = Date.now()
    let updated: TeamTask | undefined
    let refusal: unknown
    try {
      await this.store.update((current) => {
        const target = current.tasks.find(task => task.id === id)
        if (target === undefined) throw new Error(`task "${id}" does not exist on this board`)
        guard?.(target, current.tasks)
        return {
          ...current,
          tasks: current.tasks.map((task) => {
            if (task.id !== id) return task
            const changes = patch(target)
            const status = changes.status ?? task.status
            // The revision advances here and nowhere else, so every mutation is a
            // visible CAS step even when the caller did not ask for one.
            updated = {
              ...task,
              ...changes,
              // Leaving the waiting state clears what it was waiting for, here
              // rather than in each transition: a forgotten clear would leave a
              // finished task claiming it is still waiting on a person.
              ...(status === 'needs-review' ? {} : { waitingOn: undefined, waitingSince: undefined }),
              // The ledger is appended by the one writer, so a transition added
              // later cannot forget to record itself. A mutation that leaves the
              // status alone is not a transition and is not logged.
              ...(status === task.status ? {} : {
                history: [...task.history, {
                  at: now,
                  by: boundedTeamText(actor, 120) || 'board',
                  from: task.status,
                  to: status,
                  note: changes.note,
                }].slice(-HISTORY_LIMIT),
              }),
              version: task.version + 1,
              updatedAt: now,
            }
            return updated
          }),
        }
      })
    } catch (error) {
      refusal = error
    }
    // `unknown` from the catch, so coerce before throwing: a non-Error rejection is
    // preserved as-is only when it is already an Error, which is what the
    // repository's other throw sites do.
    if (refusal !== undefined) throw refusal instanceof Error ? refusal : new Error(String(refusal))
    if (updated === undefined) throw new Error(`task "${id}" disappeared during update`)
    return updated
  }
}
