/**
 * Narrowing a stop-time review to the files *this turn* changed.
 *
 * Why the workspace's dirty set is the wrong scope
 * ------------------------------------------------
 * `git status` answers "what is uncommitted", which is not the same question as
 * "what did this turn touch". A workspace can carry a file that was already
 * modified before the conversation started, or edited in an earlier turn and never
 * committed, and the difference matters in both directions: the review would pay
 * for those files on every turn, and — worse, in `gate` mode — their findings would
 * be injected into the conversation as findings about *this* turn's change set,
 * sending the agent off to answer for code it did not write here.
 *
 * The Host already knows better. The `workspace-changes` package records the files
 * each top-level turn changed, announced by a `workspace/changes` event whose
 * summary is served by the `workspaceChanges` service. This module reads that
 * record, and is where the two rules that make it safe live.
 *
 * The two rules
 * -------------
 * **Only this turn's record counts.** The announcement is appended while the turn
 * is stopping, and a reader can run before the recorder has appended it — so the
 * newest `workspace/changes` event may belong to an *earlier* turn. The turn number
 * is therefore matched exactly, and a record that does not match is no evidence at
 * all rather than a guess.
 *
 * **A narrowed scope must be provably inside the changed set.** The two lists come
 * from different modules with different notions of a path: the turn record is
 * relative to the session's working directory, while the review's paths are
 * relative to the worktree root, and a session open in a subdirectory makes those
 * two spellings disagree. Narrowing on a list that does not lie inside the change
 * set would silently review **nothing** — the failure this whole review pipeline
 * exists to prevent — so the narrowing is refused unless every path is already in
 * the change set. Every refusal falls back to the wider scope, which is what the
 * gate did before this module existed.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/review/turn-scope
 */

/** The slice of a session event this reader needs. */
export interface TurnScopeEvent {
  readonly type: string
  readonly seq: number
  /** The event's payload, read defensively: a foreign event may hold anything. */
  readonly data?: unknown
}

/**
 * What a summary looks like to this reader.
 *
 * Structural rather than imported: the plugin needs one field of a Host service it
 * does not depend on, and a composition without that service must be able to run
 * with the wider scope instead of failing to load.
 */
export interface TurnScopeSummary {
  readonly files?: readonly { readonly path?: unknown }[]
}

/** How the Host's per-turn record is reached. */
export type TurnScopeSummarize = (sessionId: string, seq: number) => TurnScopeSummary | undefined

/**
 * The paths one turn changed, from the Host's own record.
 *
 * @param options.sessionId - the session whose record is being read.
 * @param options.turn - the turn that is stopping; `undefined` reads nothing.
 * @param options.events - the session's events, in log order.
 * @param options.summarize - the Host service lookup.
 * @returns the turn's changed paths, or `undefined` when the Host has no record
 * for *this* turn.
 */
export function turnChangePaths(options: {
  readonly sessionId: string
  readonly turn: number | undefined
  readonly events: readonly TurnScopeEvent[]
  readonly summarize: TurnScopeSummarize
}): readonly string[] | undefined {
  if (options.turn === undefined) return undefined
  for (let index = options.events.length - 1; index >= 0; index -= 1) {
    const event = options.events[index] as TurnScopeEvent
    if (event.type !== 'workspace/changes') continue
    const turn = (event.data as { readonly turn?: unknown } | undefined)?.turn
    // A record for another turn is not a partial answer about this one, and it is
    // what a reader that ran before the recorder appended this turn's record sees.
    if (turn !== options.turn) return undefined
    const summary = options.summarize(options.sessionId, event.seq)
    if (summary === undefined) return undefined
    const paths = (summary.files ?? [])
      .map(file => file.path)
      .filter((path): path is string => typeof path === 'string' && path !== '')
    // `files` is capped while `total` is complete, so an empty list is ambiguous —
    // and an ambiguous answer must not narrow anything.
    return paths.length === 0 ? undefined : paths
  }
  return undefined
}

/**
 * Narrow the change set to the turn's own files, or keep it.
 *
 * @param turnPaths - the paths the Host says this turn changed, when it has a record.
 * @param changedPaths - the change set the review would otherwise cover.
 * @returns the paths to review: the turn's own when they are provably part of the
 * change set, and the change set itself otherwise.
 */
export function narrowTurnScope(
  turnPaths: readonly string[] | undefined,
  changedPaths: readonly string[],
): readonly string[] {
  if (turnPaths === undefined || turnPaths.length === 0) return changedPaths
  const changed = new Set(changedPaths)
  // Every path, not any: one path outside the change set means the two lists are
  // spelled in different coordinate systems, and reviewing a subset of a list that
  // does not match would drop the files it failed to match.
  return turnPaths.every(path => changed.has(path)) ? turnPaths : changedPaths
}
