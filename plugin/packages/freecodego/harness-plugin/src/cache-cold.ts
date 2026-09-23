/**
 * Cache-cold clearing: do the shrinking when the cache is already dead.
 *
 * Why
 * ---
 * Claude Code splits compaction into two mechanisms that are mutually exclusive,
 * and the split is the whole idea (`services/compact/`):
 *
 * - **Cached microcompact** assumes a warm cache and edits the cached prefix
 *   through the provider's cache-editing facility, so nothing is re-billed.
 * - **Time-based microcompact** assumes the cache is already cold: when the gap
 *   since the last assistant message exceeds a threshold, the provider's cache
 *   has almost certainly expired and **the entire prefix is going to be rewritten
 *   no matter what**. Clearing old tool results *before* the request shrinks the
 *   thing that is about to be re-sent.
 *
 * Their word for why this is free: "we never force a miss that wouldn't have
 * happened." That is the argument this module is built on, and their default
 * threshold is chosen to make it airtight — 60 minutes, because a one-hour TTL is
 * guaranteed expired by then for every user, whereas a shorter threshold would
 * sometimes clear a prefix that was still cached.
 *
 * The second half of their reasoning matters just as much and is easy to miss:
 * this must run **before** the request. Running it after the first miss only
 * helps later turns, and the expensive turn has already been paid for.
 *
 * This pairs with `cache-attribution.ts`: when a miss is attributed to
 * `idle-gap`, the cause is already known and the remedy is not "compact" but
 * "clear the dead weight now, while it is free".
 *
 * State lives here (cooldown, per-session count, keep-recent) because both halves
 * of the decision — may we fire, and what may we clear — need to agree on the
 * same session history to be worth anything.
 *
 * Two properties of the second half were wrong here, and both had already been
 * solved in the sibling implementation that reached this same design from the
 * other direction (ZCode's `packages/core/src/compact/microcompact.ts`, which
 * splits its keep window the same way but measures it differently). These are
 * both about *what the keep window protects*:
 *
 * - **The window counts turns, not results.** A turn that issues twelve parallel
 *   reads is one unit of work the model is still holding; a window of "the newest
 *   five results" kept five of those twelve and cleared the other seven, which is
 *   the opposite of keeping what the model is working against. A group is the
 *   candidates sharing one assistant turn.
 * - **A result made of anything but text is never clearable.** Clearing replaces
 *   a result's entire content array with one text marker, so a block that is not
 *   text is *destroyed* by the rewrite rather than shrunk — and nothing in the
 *   accounting shows it, because the reclaimed figure counts only text. An image
 *   block reaches a tool result today (`tool-fs`'s `read_image`), and the list of
 *   clearable tools below is a policy list that has already been wrong once in
 *   production, so the guard belongs on the transform and not on the list.
 *
 * One thing that reference does and this module deliberately does not: it also
 * fires on **token pressure**
 * (its threshold is `min(0.9 × autocompact, autocompact − 2000)`), which clears a
 * warm prefix on purpose. Everything above exists to avoid exactly that — "we
 * never force a miss that wouldn't have happened" — and the reference can afford
 * it because clearing is its last resort beneath full compaction. Here the same
 * question is answered in money instead (`compaction-economics.ts`), so the
 * pressure trigger is not a gap to be filled: adding it would buy a cache write
 * whose worth this repository already computes somewhere else.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/cache-cold
 */

import { tokensFromChars } from './token-estimate.ts'

/**
 * Tool results are the payload that grows without bound; these kinds are eligible for clearing.
 *
 * Both shells are named, and that is load-bearing rather than tidy: the base
 * `cordis.patch.yml` disables `tool-bash` on win32 and enables `tool-pwsh`, so a
 * Windows session's only shell is the one spelling a POSIX-only list omits.
 * `selectResultsToClear`, `clearOldToolResults` and `eligibleResults` all read
 * this list, so on that platform command output — the payload the list exists
 * for — was filtered out of every one of them and `reclaimedTokens` stayed 0.
 *
 * The inert names further down (`exec_command`, `run_command`, `cat`, `find`,
 * `list_files`) stay on purpose: they are spellings other agents use, and a name
 * with no registration here is inert while a missing one is a hole.
 *
 * The last name in the reader group is the one this plugin registers itself:
 * `read_document` is where a PDF's or a notebook's text enters the transcript
 * (the harness `read` returns bytes for one and raw JSON for the other), and
 * its cap -- 60 000 characters by default, 400 000 at most -- is the largest in
 * the plugin, which makes it the biggest producer of the payload this list
 * exists for. Every other curated list that has to know it names it (the
 * deferred-tool set, plan mode's two read-only sets, its own prompt line), so
 * its absence here was a gap rather than a policy.
 */
export const CLEARABLE_TOOL_KINDS: readonly string[] = [
  'read', 'read_file', 'file_read', 'read_document', 'cat',
  'shell', 'bash', 'pwsh', 'exec_command', 'run_command',
  'grep', 'search', 'glob', 'find', 'list_files',
  'web_fetch', 'web_search', 'fetch',
]

/**
 * The thresholds that decide when a cache is provably cold.
 */
export interface CacheColdConfig {
  /** Gap since the last assistant message at or above which the cache is presumed cold. */
  readonly gapThresholdMs: number
  /**
   * Most-recent compactable **turns** to keep, in order of appearance.
   *
   * The unit is the assistant turn, not the individual result: every result that
   * answers one assistant message is one unit, however many calls it made. See
   * {@link clearableWindow} for why the unit is a turn.
   */
  readonly keepRecentResults: number
  /** Minimum wait between two clearing passes, so a burst cannot thrash the transcript. */
  readonly cooldownMs: number
  /** Hard cap per conversation: clearing is a rescue, not a steady-state policy. */
  readonly maxPerSession: number
  /** Do not bother below this much reclaimable content. */
  readonly minReclaimTokens: number
}

/**
 * Defaults.
 *
 * `gapThresholdMs` is deliberately one hour rather than "5 minutes plus slack":
 * the point is to be *certain* the cache is cold, because a threshold that fires
 * early clears a prefix that was still cached and turns a free operation into a
 * billable one.
 */
export const CACHE_COLD_DEFAULTS: CacheColdConfig = {
  gapThresholdMs: 60 * 60_000,
  keepRecentResults: 5,
  cooldownMs: 5 * 60_000,
  maxPerSession: 3,
  minReclaimTokens: 2_000,
}

/** One result already in the transcript, as the caller can see it. */
export interface ClearableResult {
  /** Inclusive surface sequence number of the tool result. */
  readonly seq: number
  readonly tool: string
  readonly tokens: number
  /**
   * Ordinal of the assistant turn this result answers, when the caller knows it.
   *
   * Results sharing a turn share a keep slot. A candidate with no turn is its own
   * group, because a result that cannot be proven to belong with others cannot be
   * protected by them.
   */
  readonly turn?: number | undefined
}

/**
 * A clearable result with the identity and payload the retrieval path needs.
 *
 * The policy is deliberately blind to both: it chooses *which* results to clear
 * by position, and adding a payload to its input would make it look like clearing
 * depends on content. Only the view path — which parks the text so the model can
 * read it back — needs to address a result and carry its text.
 */
export interface ClearableResultPayload extends ClearableResult {
  /** The tool call this result answers; the address a spilled copy is keyed by. */
  readonly callId: string
  /** The model-visible text this result currently carries. */
  readonly text: string
}

/**
 * The facts about one conversation a trigger check reads.
 */
export interface CacheColdInput {
  /** Epoch ms of the last assistant message, when the conversation has one. */
  readonly lastAssistantAt?: number | undefined
  readonly now: number
  /** Epoch ms of this conversation's last clearing pass, when it had one. */
  readonly lastClearedAt?: number | undefined
  /** Clearing passes already performed for this conversation. */
  readonly clearedCount: number
  readonly candidates: readonly ClearableResult[]
}

/**
 * Why a clearing pass did not fire.
 */
export type CacheColdRefusal =
  | 'no-assistant-message'
  | 'gap-below-threshold'
  | 'cooldown-active'
  | 'session-cap-reached'
  | 'nothing-clearable'
  | 'below-reclaim-floor'

/**
 * The outcome of one caching-policy decision.
 */
export interface CacheColdDecision {
  readonly fire: boolean
  /** Present when `fire` is false. */
  readonly refusal?: CacheColdRefusal
  /** Measured gap, when one could be measured. */
  readonly gapMs?: number
  /** Surface seqs to clear, in ascending order. */
  readonly clearSeqs: readonly number[]
  readonly reclaimedTokens: number
  /** The most recent results that must survive because they are recent. */
  readonly keptSeqs: readonly number[]
}

/**
 * Decide whether the cache is provably cold enough to clear for free.
 *
 * Refusals are named rather than collapsed into "did not fire", because they lead
 * to different responses: `cooldown-active` means wait, `session-cap-reached`
 * means stop trying this conversation, and `nothing-clearable` means the policy
 * is fine but the transcript has nothing worth clearing.
 * @param input - the conversation facts the check reads.
 * @param config - the thresholds; defaults to the shipped configuration.
 * @returns whether the policy may fire, with the refusal or measured gap.
 */
export function evaluateCacheColdTrigger(input: CacheColdInput, config: CacheColdConfig = CACHE_COLD_DEFAULTS): { fire: boolean; refusal?: CacheColdRefusal; gapMs?: number } {
  if (input.lastAssistantAt === undefined || !Number.isFinite(input.lastAssistantAt)) return { fire: false, refusal: 'no-assistant-message' }
  const gapMs = Math.max(0, input.now - input.lastAssistantAt)
  if (gapMs < config.gapThresholdMs) return { fire: false, refusal: 'gap-below-threshold', gapMs }
  if (input.clearedCount >= config.maxPerSession) return { fire: false, refusal: 'session-cap-reached', gapMs }
  if (input.lastClearedAt !== undefined && input.now - input.lastClearedAt < config.cooldownMs) {
    return { fire: false, refusal: 'cooldown-active', gapMs }
  }
  return { fire: true, gapMs }
}

/**
 * Split ordered candidates into the newest groups that survive and the older ones
 * that are cleared.
 *
 * The window's unit is the **assistant turn**, not the result. A turn that issues
 * twelve parallel reads produced twelve results, all of them answers to one
 * question the model is still holding; a window counted in results keeps five of
 * them and clears seven, which contradicts the reason the window exists. Grouping
 * makes the window mean what the policy says it means.
 *
 * Consecutive candidates declaring the same turn form one group; a candidate with
 * no declared turn stands alone, so a caller that supplies only sizes keeps
 * per-result behavior. Order is preserved within a group, so the cleared set is
 * still an ascending span.
 *
 * This is the single implementation of the window because three callers must
 * agree on it: the policy counts what it will do, {@link CacheColdView.clearTargets}
 * parks exactly that set, and {@link clearOldToolResults} performs it. A window
 * computed twice is a window that can disagree with itself, and the disagreement
 * would be invisible — the plan would report a saving the transform did not make.
 * @param ordered - clearable candidates in ascending transcript order.
 * @param keepRecent - how many newest groups survive.
 * @returns the older candidates to clear and the newest groups to keep.
 */
function clearableWindow<T extends { readonly seq: number; readonly turn?: number | undefined }>(
  ordered: readonly T[],
  keepRecent: number,
): { readonly clear: readonly T[]; readonly keep: readonly T[] } {
  const keep = Math.max(1, keepRecent)
  const groups: T[][] = []
  let current: T[] | undefined
  let currentTurn: number | undefined
  for (const candidate of ordered) {
    const turn = candidate.turn
    if (current !== undefined && turn !== undefined && currentTurn === turn) {
      current.push(candidate)
      continue
    }
    current = [candidate]
    currentTurn = turn
    groups.push(current)
  }
  const split = Math.max(0, groups.length - keep)
  return { clear: groups.slice(0, split).flat(), keep: groups.slice(split).flat() }
}

/**
 * Choose which results to clear.
 *
 * Selection is by **position**, not by size: the newest turns are kept whatever
 * they weigh, because the newest turns are the ones the model is still working
 * against. Clearing a huge old result is tempting and wrong if it is also the
 * current file.
 *
 * A result whose tool is not in {@link CLEARABLE_TOOL_KINDS} is never a candidate
 * — edit and write results are the record of what changed, and the model
 * byte-patches against them.
 * @param candidates - the tool results already in the transcript.
 * @param config - the thresholds; defaults to the shipped configuration.
 * @returns the seqs to clear, the recent seqs kept, and the tokens reclaimed.
 */
export function selectResultsToClear(candidates: readonly ClearableResult[], config: CacheColdConfig = CACHE_COLD_DEFAULTS): { clearSeqs: readonly number[]; keptSeqs: readonly number[]; reclaimedTokens: number } {
  const ordered = candidates
    .filter(candidate => CLEARABLE_TOOL_KINDS.includes(candidate.tool))
    .sort((left, right) => left.seq - right.seq)
  const window = clearableWindow(ordered, config.keepRecentResults)
  return {
    clearSeqs: window.clear.map(candidate => candidate.seq),
    keptSeqs: window.keep.map(candidate => candidate.seq),
    reclaimedTokens: window.clear.reduce((sum, candidate) => sum + Math.max(0, candidate.tokens), 0),
  }
}

/**
 * A decision plus the transcript span it replaces.
 */
export interface CacheColdPlan extends CacheColdDecision {
  /** The span to hand the compaction engine, when there is one. */
  readonly span?: { readonly start: number; readonly end: number } | undefined
}

/**
 * Per-conversation clearing state.
 *
 * `plan()` and `commit()` are separate for the same reason as the fragment log:
 * a plan that is measured but never applied (no engine mounted, the request
 * aborted) must not count against the cooldown or the session cap, or the
 * conversation silently loses its allowance without ever being cleared.
 */
export class CacheColdPolicy {
  private readonly cleared = new Map<string, { at: number; count: number }>()

  constructor(private readonly config: CacheColdConfig = CACHE_COLD_DEFAULTS) {}

/**
 * The configuration this policy was built with.
 * @returns the policy's configuration.
 */
  limits(): CacheColdConfig {
    return this.config
  }

/**
 * Measure whether this conversation may clear, without recording it.
 * @param sessionId - the conversation the plan is measured for.
 * @param input - the conversation facts, minus the state this policy owns.
 * @returns the plan, including the span to replace when it fires.
 */
  plan(sessionId: string, input: Omit<CacheColdInput, 'clearedCount' | 'lastClearedAt'>): CacheColdPlan {
    const state = this.cleared.get(sessionId)
    const trigger = evaluateCacheColdTrigger({
      ...input,
      ...(state === undefined ? {} : { lastClearedAt: state.at }),
      clearedCount: state?.count ?? 0,
    }, this.config)
    if (!trigger.fire) {
      return { fire: false, ...(trigger.refusal === undefined ? {} : { refusal: trigger.refusal }), ...(trigger.gapMs === undefined ? {} : { gapMs: trigger.gapMs }), clearSeqs: [], keptSeqs: [], reclaimedTokens: 0 }
    }
    const selection = selectResultsToClear(input.candidates, this.config)
    if (selection.clearSeqs.length === 0) {
      return { fire: false, refusal: 'nothing-clearable', ...(trigger.gapMs === undefined ? {} : { gapMs: trigger.gapMs }), ...selection }
    }
    if (selection.reclaimedTokens < this.config.minReclaimTokens) {
      return { fire: false, refusal: 'below-reclaim-floor', ...(trigger.gapMs === undefined ? {} : { gapMs: trigger.gapMs }), ...selection }
    }
    const start = selection.clearSeqs[0]!
    const end = selection.clearSeqs[selection.clearSeqs.length - 1]!
    // The candidates are results, but the span the engine replaces runs from the
    // earliest cleared result through the last one; intervening assistant and
    // tool-call events inside that span go with it, which is what makes this a
    // span replacement rather than a per-event edit.
    return {
      fire: true,
      ...(trigger.gapMs === undefined ? {} : { gapMs: trigger.gapMs }),
      ...selection,
      span: { start, end },
    }
  }

/**
 * Record that a plan fired for this conversation.
 * @param sessionId - the conversation the plan fired for.
 * @param now - the time the pass ran.
 */
  commit(sessionId: string, now: number): void {
    const state = this.cleared.get(sessionId)
    this.cleared.set(sessionId, { at: now, count: (state?.count ?? 0) + 1 })
  }

/**
 * This conversation's clearing state, when it has one.
 * @param sessionId - the conversation to read.
 * @returns the last-clear time and pass count, or `undefined` when none is recorded.
 */
  state(sessionId: string): { at: number; count: number } | undefined {
    return this.cleared.get(sessionId)
  }

/**
 * Drop this conversation's clearing state.
 * @param sessionId - the conversation to forget.
 */
  forget(sessionId: string): void {
    this.cleared.delete(sessionId)
  }

/**
 * Drop every conversation's clearing state.
 */
  clear(): void {
    this.cleared.clear()
  }
}

/**
 * Stable prefix every cleared-result marker starts with.
 *
 * Idempotency is checked against this prefix rather than by whole-string
 * equality, because a marker may also carry a spill locator (see
 * {@link clearedResultMarker}). The transform has to recognize its own output on
 * the next request whichever variant wrote it — a second pass that failed to
 * recognize a cleared result would re-clear it and move the cache break from the
 * first request to the second, which is the one thing this module exists to
 * avoid.
 */
export const CLEARED_RESULT_PREFIX = '[Old tool result content cleared to reclaim context;'

/**
 * The marker the Harness's own pruner leaves inside a tool result it shrank.
 *
 * `@deepseek-ai/dsh-compaction-tool-result-pruner` replaces an oversized result's
 * middle with this text (`PRUNE_MARKER`) as a durable `tool/result` replacement the
 * token meter prices, so a result carrying it has already been shrunk by the
 * Harness. Clearing it here would be the plugin taking over a result the Harness
 * owns, and the cost is worse than duplicated work: the text this module would park
 * is the *remnant* (head + marker + tail) while the marker it writes promises the
 * **full** result is at the locator. A false claim about what is retrievable is
 * worse than the bytes it reclaims — and there are few of those, because the
 * remnant is bounded by the pruner's own `thresholdChars` (8 KiB by default).
 *
 * A literal rather than an import, because the plugin also runs in compositions
 * that mount no pruner; `tests/cache-cold.spec.ts` reads `PRUNE_MARKER` out of the
 * pruner's source so the copy cannot drift away from the real thing.
 */
export const HARNESS_PRUNE_MARKER = '[... tool result middle pruned ...]'

/** Marker for a cleared result whose text was not parked anywhere retrievable. */
export const CLEARED_RESULT_MARKER = `${CLEARED_RESULT_PREFIX} it was already re-sent at full price and is not recoverable from this view]`

/** Where a cleared result's full text can be read back, as the spill backend described it. */
export interface ClearedResultLocation {
  /** Opaque model-facing handle produced by the spill backend. */
  readonly locator: string
  /** The backend's guidance on how to read or search the artifact. */
  readonly retrievalHint: string
}

/**
 * Marker for a cleared result whose full text was parked.
 *
 * This replaces "not recoverable from this view" with somewhere to look, which is
 * the whole point: without it the model's only way back to cleared content is to
 * re-run the tool, and that spends the tokens the clear just saved. The prefix is
 * shared with {@link CLEARED_RESULT_MARKER} because the extra text is addressed
 * to the model, not to this module, and must not change what counts as cleared.
 * @param location - the parked copy's locator and retrieval hint.
 * @returns the marker text the model sees in place of the result.
 */
export function clearedResultMarker(location: ClearedResultLocation): string {
  return `${CLEARED_RESULT_PREFIX} the full text was parked instead, and can be read back: ${location.locator} (${location.retrievalHint})]`
}

/**
 * The minimum a message must expose to be filtered.
 *
 * A tool result is a `tool`-role message whose `content` IS the result's own
 * blocks and whose `toolCallId` names the call it answers. It used to be a
 * `user`-role message holding one `tool-result` block that carried those same
 * two things one level down, which is why every reader here used to reach into
 * `content[0]`; the transform was independent of the transcript's storage shape
 * except for that nesting, and the nesting is what the core removed.
 */
export interface MessageLike {
  readonly role?: unknown
  readonly content?: unknown
  /** The call this result answers, on a tool-role message. */
  readonly toolCallId?: unknown
}

/**
 * The tool a result belongs to, found through its call id.
 *
 * Messages carry no sequence number, so a tool result is matched to its tool by
 * walking back to the assistant tool-call with the same id. That is also what
 * keeps this transform independent of the transcript's storage shape.
 */
function toolNamesByCallId(messages: readonly MessageLike[]): Map<string, string> {
  const byId = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const block of message.content as readonly { readonly type?: unknown; readonly id?: unknown; readonly name?: unknown }[]) {
      if (block?.type === 'tool-call' && typeof block.id === 'string' && typeof block.name === 'string') byId.set(block.id, block.name)
    }
  }
  return byId
}

/**
 * True when this message is an assistant turn that asked for at least one tool.
 *
 * The turn ordinal is counted from these messages rather than read from a seq,
 * because a turn is exactly what the transcript already encodes here: an
 * assistant message, then the results answering its calls. Incrementing on the
 * assistant side and tagging the results that follow gives every result the same
 * ordinal without a second index.
 * @param message - the transcript entry to classify.
 * @returns whether this message opens a tool-using turn.
 */
function isAssistantToolCallTurn(message: MessageLike): boolean {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return false
  // The element type admits `undefined` deliberately, so the guard below is a real
  // one rather than a redundant `?.` a type-aware lint would strip: a message's
  // content array is untrusted input, and the sibling scan in `toolNamesByCallId`
  // already guards each block for the same reason.
  return (message.content as readonly ({ readonly type?: unknown } | undefined)[])
    .some(block => block?.type === 'tool-call')
}

/** Characters of model-visible text inside one content block, recursively. */
function textCharsIn(block: unknown): number {
  if (block === null || typeof block !== 'object') return 0
  const view = block as { readonly text?: unknown; readonly content?: unknown }
  let total = typeof view.text === 'string' ? view.text.length : 0
  if (Array.isArray(view.content)) for (const inner of view.content as readonly unknown[]) total += textCharsIn(inner)
  return total
}

/**
 * True when this result's only content is a cleared marker.
 *
 * Matched by prefix, not equality: a marker that carries a locator is a different
 * string from the plain one, and both have to count as cleared.
 */
function isAlreadyCleared(message: MessageLike, prefix: string = CLEARED_RESULT_PREFIX): boolean {
  const text = resultText(message)
  return text !== undefined && text.startsWith(prefix)
}

/**
 * True when the Harness's own pruner already replaced part of this result.
 *
 * Not the same question as {@link isAlreadyCleared}: that one asks whether this
 * module's marker is what the model sees, while this asks whether the *Harness* has
 * already shrunk the result and owns what is left of it. See
 * {@link HARNESS_PRUNE_MARKER} for why clearing the remnant is worse than leaving
 * it — the parked text would be the remnant under a marker promising the original.
 * @param message - the transcript entry to inspect.
 * @returns whether the result text carries the Harness's prune marker.
 */
function isHarnessPruned(message: MessageLike): boolean {
  const text = resultText(message)
  return text !== undefined && text.includes(HARNESS_PRUNE_MARKER)
}

/**
 * True when this result is made of nothing but text blocks.
 *
 * This is a *destructive* test rather than a measuring one, and that is the whole
 * reason it exists. Clearing replaces a result's entire content array with one
 * text marker, so any block that is not text is deleted by the rewrite instead of
 * being shrunk — and the accounting would not show it, because the reclaimed
 * figure sums text. An `image` block reaches a tool result today
 * (`tool-fs`'s `read_image` returns one beside its text block), and the tool list
 * that gates clearing is a policy list this module's own history records as
 * having already been wrong in production once, so the guard is written on the
 * transform rather than trusted to the list.
 *
 * The test is an allowlist — every block must be text, and there must be at least
 * one — rather than ZCode's denylist of `image`/`video`/`file`, which is the same
 * guard with a hole in it: a block kind added later would be destroyed silently,
 * where an allowlist protects it until someone decides otherwise.
 * @param message - the transcript entry to inspect.
 * @returns whether every content block in this tool result is visible text.
 */
function hasOnlyTextContent(message: MessageLike): boolean {
  if (message.role !== 'tool' || !Array.isArray(message.content)) return false
  const blocks = message.content as readonly ({ readonly type?: unknown } | undefined)[]
  if (blocks.length === 0) return false
  return blocks.every(block => block?.type === 'text')
}

/**
 * Whether this message is a tool result this module may replace.
 *
 * The rule lives in one place because the policy counts what the transform will
 * do: enforced in only one of the two callers, the plan's reclaimed-token figure
 * would describe a different transform than the one that runs.
 * @param message - the transcript entry to test.
 * @param tool - the tool this result answers, when it could be resolved.
 * @param clearable - the tool names eligible for clearing.
 * @param clearedMarker - the marker text that already counts as cleared.
 * @returns whether clearing this result is permitted.
 */
function isClearableResult(message: MessageLike, tool: string | undefined, clearable: readonly string[], clearedMarker: string): boolean {
  if (tool === undefined || !clearable.includes(tool)) return false
  if (isAlreadyCleared(message, clearedMarker)) return false
  if (isHarnessPruned(message)) return false
  return hasOnlyTextContent(message)
}

/**
 * The model-visible text inside one tool result, or `undefined` for any other message.
 *
 * Text blocks are joined with a newline rather than an empty string so spilling and
 * measuring agree on the payload the model actually saw.
 */
function resultText(message: MessageLike): string | undefined {
  if (message.role !== 'tool' || !Array.isArray(message.content)) return undefined
  const texts: string[] = []
  for (const block of message.content as readonly { readonly type?: unknown; readonly text?: unknown }[]) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
  }
  return texts.join('\n')
}

function resultCallId(message: MessageLike): string | undefined {
  return message.role === 'tool' && typeof message.toolCallId === 'string' ? message.toolCallId : undefined
}

/**
 * Replace all but the newest `keepRecent` clearable tool results with a marker.
 *
 * Why a *view* transform and not a rewrite of the stored transcript: the shrink
 * has to be identical on every later request or the cache break moves from the
 * first request to the second, and it must be idempotent because a cached view is
 * cheaper than a durable mutation. The stored session keeps every byte, so the
 * original is still recoverable from the log — this only changes what the model
 * is sent. That is why it can be free when the cache is cold and unacceptable
 * when it is warm.
 *
 * Messages that are not clearable results are returned by reference, so nothing
 * unrelated is rebuilt and the transform costs one pass.
 * @param messages - the transcript to transform.
 * @param options - the keep window, clearable tools, and marker overrides.
 * @returns the transformed messages and the cleared and kept call ids.
 */
export function clearOldToolResults(
  messages: readonly MessageLike[],
  options: { readonly keepRecentResults?: number; readonly clearableTools?: readonly string[]; readonly marker?: string; readonly markers?: ReadonlyMap<string, string> } = {},
): { readonly messages: readonly MessageLike[]; readonly clearedCallIds: readonly string[]; readonly reclaimedChars: number; readonly keptCallIds: readonly string[] } {
  const clearable = options.clearableTools ?? CLEARABLE_TOOL_KINDS
  const marker = options.marker ?? CLEARED_RESULT_MARKER
  const markers = options.markers
  // Detection prefix. A caller-supplied marker is matched as given, because its
  // text is not ours to parse; our own markers are matched on the shared prefix so
  // that a locator-carrying variant still counts as cleared. Matching on the whole
  // default marker would make this transform non-idempotent the moment a result
  // carried a locator — the second pass would fail to recognize its own output.
  const clearedMarker = options.marker ?? CLEARED_RESULT_PREFIX
  const names = toolNamesByCallId(messages)

  // Eligible results in transcript order, each carrying the assistant turn it
  // answers so the window can group them. The eligibility rule is
  // `isClearableResult`, the same one the policy counts with — an already-cleared
  // result still looks eligible (same tool, same call id), so without that check a
  // second pass reports clearing it again, and a shrink that is not idempotent
  // moves the cache break from the first request to the second.
  const eligible: { seq: number; turn?: number }[] = []
  let turn = 0
  let current: number | undefined
  for (const [index, message] of messages.entries()) {
    if (isAssistantToolCallTurn(message)) { turn += 1; current = turn; continue }
    const callId = resultCallId(message)
    if (callId === undefined) continue
    if (!isClearableResult(message, names.get(callId), clearable, clearedMarker)) continue
    eligible.push(current === undefined ? { seq: index } : { seq: index, turn: current })
  }
  const window = clearableWindow(eligible, options.keepRecentResults ?? CACHE_COLD_DEFAULTS.keepRecentResults)
  if (window.clear.length === 0) {
    const keptCallIds = window.keep
      .map(entry => resultCallId(messages[entry.seq]!)!)
      .filter(Boolean)
    return { messages, clearedCallIds: [], reclaimedChars: 0, keptCallIds }
  }

  const clearing = new Set(window.clear.map(entry => entry.seq))
  const keptCallIds: string[] = []
  const clearedCallIds: string[] = []
  let reclaimedChars = 0
  const next = messages.map((message, index) => {
    const callId = resultCallId(message)
    if (callId === undefined) return message
    if (!clearing.has(index)) { keptCallIds.push(callId); return message }
    clearedCallIds.push(callId)
    // A per-result marker wins over the shared one: it carries that result's own
    // locator. The fallback is not a failure path to be ashamed of — it is what a
    // deployment with no spill backend gets, and what it got before.
    const replacement = markers?.get(callId) ?? marker
    const original = Array.isArray(message.content) ? (message.content as readonly { readonly type?: unknown; readonly content?: unknown }[]) : []
    // Measured from the blocks actually being replaced, minus the marker that
    // takes their place, so the caller's "is this worth it" test counts the same
    // saving the model will see rather than the message's raw size.
    const blockChars = original.reduce((sum, block) => sum + textCharsIn(block), 0)
    reclaimedChars += Math.max(0, blockChars - replacement.length)
    // Only `content` is replaced: `role`, `toolCallId`, `source`, and `isError`
    // stay, so the cleared result still answers the same call and the caller's
    // tool bookkeeping sees no change beyond the text.
    return { ...message, content: [{ type: 'text' as const, text: replacement }] }
  })
  return { messages: next, clearedCallIds, reclaimedChars, keptCallIds }
}

/**
 * The clearable results in a message array, in order, with their character cost.
 *
 * `seq` is the position in this array: the view path never needs a durable
 * sequence number, and using the index keeps the ordering honest for the
 * position-based keep window.
 */
function eligibleResults(messages: readonly MessageLike[]): readonly ClearableResultPayload[] {
  const names = toolNamesByCallId(messages)
  const candidates: ClearableResultPayload[] = []
  // The turn ordinal is counted here exactly as the transform counts it, so the
  // keep window the policy prices is the window the transform will apply.
  let turn = 0
  let current: number | undefined
  for (const [index, message] of messages.entries()) {
    if (isAssistantToolCallTurn(message)) { turn += 1; current = turn; continue }
    const callId = resultCallId(message)
    if (callId === undefined) continue
    // Already-cleared results are not candidates: their text is the marker, and
    // both the reclaimed-token estimate and the spill path would be counting a
    // marker as payload. A harness-pruned result is not one either: it holds no
    // payload the model could still lose, and a keep slot spent on a remnant is a
    // slot taken from a result that has one. Both rules and the text-only guard
    // live in `isClearableResult`, which is the same set `clearOldToolResults`
    // acts on — that is what lets the caller park exactly what it is about to
    // replace, and never one that survives.
    const tool = names.get(callId)
    if (tool === undefined || !isClearableResult(message, tool, CLEARABLE_TOOL_KINDS, CLEARED_RESULT_PREFIX)) continue
    const text = resultText(message) ?? ''
    candidates.push({
      seq: index,
      tool,
      tokens: tokensFromChars(text.length),
      callId,
      text,
      ...(current === undefined ? {} : { turn: current }),
    })
  }
  return candidates
}

/**
 * A session's shrunk view, held stable across every later step.
 *
 * The trigger only fires once — after the first clear the gap is short again — but
 * the *view* has to keep being shrunk, or the next step would restore the full
 * transcript and move the cache break from the first request to the second. So the
 * decision is made once, its parameters are captured, and `apply` reproduces the
 * same view for every subsequent call. That is what makes an operation that is
 * only free when the cache is cold safe to keep doing when it is warm again.
 *
 * `apply` returns the input array by reference when no shrink is in effect, so a
 * session that never qualifies pays one array walk and nothing else.
 */
export class CacheColdView {
  private readonly active = new Map<string, { readonly keepRecentResults: number; readonly markers: Map<string, string> }>()

  constructor(private readonly policy: CacheColdPolicy = new CacheColdPolicy()) {}

  /** The policy this view consults, for diagnostics and for the tool surface. */
  get decision(): CacheColdPolicy {
    return this.policy
  }

  /** Whether this session's view is currently shrunk. 
   * @param sessionId - the Harness session this operation acts on.
 * @returns whether this session's view is currently shrunk.
   */
  shrunk(sessionId: string): boolean {
    return this.active.has(sessionId)
  }

  /**
   * Decide whether to start shrinking, and record it if so.
   *
   * Candidates are derived from the message array rather than supplied, because
   * the caller already has it and a second enumeration is a second thing to keep
   * in step with the transform.
   *
   * Recording happens here rather than in `apply` because the decision to clear is
   * the thing that must not repeat: a second `plan` inside the cooldown must be
   * refused even though the view stays shrunk.
   * @param sessionId - the Harness session this operation acts on.
 * @param input - the conversation facts the plan is measured from.
 * @returns the decision, with the reclaimed tokens and the number of results to clear.
   */
  plan(sessionId: string, input: { readonly lastAssistantAt?: number | undefined; readonly now: number; readonly messages: readonly MessageLike[] }): { readonly fire: boolean; readonly refusal?: CacheColdRefusal; readonly gapMs?: number; readonly reclaimTokens: number; readonly clearCount: number } {
    const eligible = eligibleResults(input.messages)
    const decision = this.policy.plan(sessionId, {
      ...(input.lastAssistantAt === undefined ? {} : { lastAssistantAt: input.lastAssistantAt }),
      now: input.now,
      candidates: eligible,
    })
    if (decision.fire) {
      // Keep any markers a previous pass recorded: a plan can fire again after the
      // cooldown, and the results already parked at that point must not be parked
      // twice under two different locators.
      const existing = this.active.get(sessionId)
      this.active.set(sessionId, { keepRecentResults: this.policy.limits().keepRecentResults, markers: existing?.markers ?? new Map() })
      this.policy.commit(sessionId, input.now)
    }
    return {
      fire: decision.fire,
      ...(decision.refusal === undefined ? {} : { refusal: decision.refusal }),
      ...(decision.gapMs === undefined ? {} : { gapMs: decision.gapMs }),
      reclaimTokens: decision.reclaimedTokens,
      clearCount: decision.clearSeqs.length,
    }
  }

  /**
   * The results this view is about to replace, with their text, for parking them.
   *
   * Computed from the same eligibility rules `apply` uses and sliced to the same
   * keep window, so the caller parks exactly the set that is about to disappear
   * and never one that survives. Returns nothing while the view is unshrunk —
   * there is no replacement to justify touching storage.
   * @param sessionId - the Harness session this operation acts on.
   * @returns the clearable Result Payload rows, in backend order.
 * @param messages - the transcript the candidates are derived from.
   */
  clearTargets(sessionId: string, messages: readonly MessageLike[]): readonly ClearableResultPayload[] {
    const state = this.active.get(sessionId)
    if (state === undefined) return []
    return clearableWindow(eligibleResults(messages), state.keepRecentResults).clear
  }

  /** Whether this result already has a marker, so it is never parked a second time. 
   * @param sessionId - the Harness session this operation acts on.
   * @param callId - id of the tool call this answer belongs to.
 * @returns whether this result already carries a marker.
   */
  hasMarker(sessionId: string, callId: string): boolean {
    return this.active.get(sessionId)?.markers.has(callId) ?? false
  }

  /**
   * Remember the marker to use for each parked result.
   *
   * Stored per session and consulted on every later `apply`, because the view is
   * rebuilt on every request and must rebuild the *same* text each time or the
   * cache break moves to the second request.
   * @param sessionId - the Harness session this operation acts on.
 * @param markers - the marker to use, keyed by tool call id.
   */
  recordMarkers(sessionId: string, markers: ReadonlyMap<string, string>): void {
    const state = this.active.get(sessionId)
    if (state === undefined) return
    for (const [callId, marker] of markers) state.markers.set(callId, marker)
  }

  /**
   * Reproduce the session's view.
   *
   * Idempotent by construction: the transform skips results that already carry the
   * marker, so applying it on every step is the same as applying it once.
   * @param sessionId - the Harness session this operation acts on.
 * @param messages - the transcript to reproduce.
 * @returns the transformed messages and what changed.
   */
  apply(sessionId: string, messages: readonly MessageLike[]): { readonly messages: readonly MessageLike[]; readonly changed: boolean; readonly clearedCallIds: readonly string[]; readonly reclaimedChars: number } {
    const state = this.active.get(sessionId)
    if (state === undefined) return { messages, changed: false, clearedCallIds: [], reclaimedChars: 0 }
    const applied = clearOldToolResults(messages, { keepRecentResults: state.keepRecentResults, markers: state.markers })
    return { messages: applied.messages, changed: applied.clearedCallIds.length > 0, clearedCallIds: applied.clearedCallIds, reclaimedChars: applied.reclaimedChars }
  }

  /** Drop this session's view and its policy state.
   * @param sessionId - the conversation to forget.
   */
  forget(sessionId: string): void {
    this.active.delete(sessionId)
    this.policy.forget(sessionId)
  }

  /** Drop every session's view and policy state. */
  clear(): void {
    this.active.clear()
    this.policy.clear()
  }
}

/**
 * One-line reason, for a panel row or a log line.
 * @param refusal - the refusal to describe.
 * @returns the one-line reason.
 */
export function describeCacheColdRefusal(refusal: CacheColdRefusal): string {
  switch (refusal) {
    case 'no-assistant-message': return 'the conversation has no assistant message yet, so no cache can exist'
    case 'gap-below-threshold': return 'the gap is short enough that the cache may still be warm; clearing now could turn a free operation into a billed one'
    case 'cooldown-active': return 'a clear already ran recently for this conversation'
    case 'session-cap-reached': return 'this conversation has used its clearing allowance'
    case 'nothing-clearable': return 'no older tool result is eligible for clearing'
    case 'below-reclaim-floor': return 'the eligible results are too small to be worth a span replacement'
  }
}
