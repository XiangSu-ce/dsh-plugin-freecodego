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

export interface CacheColdConfig {
  /** Gap since the last assistant message at or above which the cache is presumed cold. */
  readonly gapThresholdMs: number
  /** Most-recent compactable tool results to keep, in order of appearance. */
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

export type CacheColdRefusal =
  | 'no-assistant-message'
  | 'gap-below-threshold'
  | 'cooldown-active'
  | 'session-cap-reached'
  | 'nothing-clearable'
  | 'below-reclaim-floor'

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
 * Choose which results to clear.
 *
 * Selection is by **position**, not by size: the newest N results are kept
 * whatever they weigh, because the newest results are the ones the model is
 * still working against. Clearing a huge old result is tempting and wrong if it
 * is also the current file.
 *
 * A result whose tool is not in {@link CLEARABLE_TOOL_KINDS} is never a candidate
 * — edit and write results are the record of what changed, and the model
 * byte-patches against them.
 */
export function selectResultsToClear(candidates: readonly ClearableResult[], config: CacheColdConfig = CACHE_COLD_DEFAULTS): { clearSeqs: readonly number[]; keptSeqs: readonly number[]; reclaimedTokens: number } {
  const ordered = [...candidates]
    .filter(candidate => CLEARABLE_TOOL_KINDS.includes(candidate.tool))
    .sort((left, right) => left.seq - right.seq)
  const keep = Math.max(1, config.keepRecentResults)
  const kept = ordered.slice(-keep)
  const clearable = ordered.slice(0, Math.max(0, ordered.length - keep))
  return {
    clearSeqs: clearable.map(candidate => candidate.seq),
    keptSeqs: kept.map(candidate => candidate.seq),
    reclaimedTokens: clearable.reduce((sum, candidate) => sum + Math.max(0, candidate.tokens), 0),
  }
}

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

  limits(): CacheColdConfig {
    return this.config
  }

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

  commit(sessionId: string, now: number): void {
    const state = this.cleared.get(sessionId)
    this.cleared.set(sessionId, { at: now, count: (state?.count ?? 0) + 1 })
  }

  state(sessionId: string): { at: number; count: number } | undefined {
    return this.cleared.get(sessionId)
  }

  forget(sessionId: string): void {
    this.cleared.delete(sessionId)
  }

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
 */
export function clearedResultMarker(location: ClearedResultLocation): string {
  return `${CLEARED_RESULT_PREFIX} the full text was parked instead, and can be read back: ${location.locator} (${location.retrievalHint})]`
}

/** The minimum a message must expose to be filtered. */
export interface MessageLike {
  readonly role?: unknown
  readonly content?: unknown
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
 * The model-visible text inside one tool result, or `undefined` for any other message.
 *
 * Text blocks are joined with a newline rather than an empty string so spilling and
 * measuring agree on the payload the model actually saw.
 */
function resultText(message: MessageLike): string | undefined {
  if (message.role !== 'user' || !Array.isArray(message.content)) return undefined
  const outer = (message.content as readonly { readonly type?: unknown; readonly content?: unknown }[])[0]
  if (outer?.type !== 'tool-result' || !Array.isArray(outer.content)) return undefined
  const texts: string[] = []
  for (const block of outer.content as readonly { readonly type?: unknown; readonly text?: unknown }[]) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
  }
  return texts.join('\n')
}

function resultCallId(message: MessageLike): string | undefined {
  if (message.role !== 'user' || !Array.isArray(message.content)) return undefined
  const first = (message.content as readonly { readonly type?: unknown; readonly toolCallId?: unknown }[])[0]
  return first?.type === 'tool-result' && typeof first.toolCallId === 'string' ? first.toolCallId : undefined
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
 */
export function clearOldToolResults(
  messages: readonly MessageLike[],
  options: { readonly keepRecentResults?: number; readonly clearableTools?: readonly string[]; readonly marker?: string; readonly markers?: ReadonlyMap<string, string> } = {},
): { readonly messages: readonly MessageLike[]; readonly clearedCallIds: readonly string[]; readonly reclaimedChars: number; readonly keptCallIds: readonly string[] } {
  const keep = Math.max(1, options.keepRecentResults ?? CACHE_COLD_DEFAULTS.keepRecentResults)
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

  const eligible: number[] = []
  for (const [index, message] of messages.entries()) {
    const callId = resultCallId(message)
    if (callId === undefined) continue
    // An already-cleared result still looks eligible — same tool, same call id — so
    // without this check a second pass reports clearing it again, and a shrink that
    // is not idempotent moves the cache break from the first request to the second.
    if (isAlreadyCleared(message, clearedMarker)) continue
    const tool = names.get(callId)
    if (tool === undefined || !clearable.includes(tool)) continue
    eligible.push(index)
  }
  if (eligible.length <= keep) return { messages, clearedCallIds: [], reclaimedChars: 0, keptCallIds: eligible.map(index => resultCallId(messages[index]!)!).filter(Boolean) }

  const clearing = new Set(eligible.slice(0, eligible.length - keep))
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
    return { ...message, content: [{ type: 'tool-result' as const, toolCallId: callId, content: [{ type: 'text' as const, text: replacement }] }] }
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
  for (const [index, message] of messages.entries()) {
    const callId = resultCallId(message)
    if (callId === undefined) continue
    const tool = names.get(callId)
    if (tool === undefined || !CLEARABLE_TOOL_KINDS.includes(tool)) continue
    // Already-cleared results are not candidates: their text is the marker, and
    // both the reclaimed-token estimate and the spill path would be counting a
    // marker as payload. This is the same set `clearOldToolResults` will act on,
    // which is what lets the caller park exactly what it is about to replace.
    if (isAlreadyCleared(message)) continue
    const text = resultText(message) ?? ''
    candidates.push({ seq: index, tool, tokens: tokensFromChars(text.length), callId, text })
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

  /** Whether this session's view is currently shrunk. */
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
   */
  clearTargets(sessionId: string, messages: readonly MessageLike[]): readonly ClearableResultPayload[] {
    const state = this.active.get(sessionId)
    if (state === undefined) return []
    const eligible = eligibleResults(messages)
    const keep = Math.max(1, state.keepRecentResults)
    return eligible.slice(0, Math.max(0, eligible.length - keep))
  }

  /** Whether this result already has a marker, so it is never parked a second time. */
  hasMarker(sessionId: string, callId: string): boolean {
    return this.active.get(sessionId)?.markers.has(callId) ?? false
  }

  /**
   * Remember the marker to use for each parked result.
   *
   * Stored per session and consulted on every later `apply`, because the view is
   * rebuilt on every request and must rebuild the *same* text each time or the
   * cache break moves to the second request.
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
   */
  apply(sessionId: string, messages: readonly MessageLike[]): { readonly messages: readonly MessageLike[]; readonly changed: boolean; readonly clearedCallIds: readonly string[]; readonly reclaimedChars: number } {
    const state = this.active.get(sessionId)
    if (state === undefined) return { messages, changed: false, clearedCallIds: [], reclaimedChars: 0 }
    const applied = clearOldToolResults(messages, { keepRecentResults: state.keepRecentResults, markers: state.markers })
    return { messages: applied.messages, changed: applied.clearedCallIds.length > 0, clearedCallIds: applied.clearedCallIds, reclaimedChars: applied.reclaimedChars }
  }

  forget(sessionId: string): void {
    this.active.delete(sessionId)
    this.policy.forget(sessionId)
  }

  clear(): void {
    this.active.clear()
    this.policy.clear()
  }
}

/** One-line reason, for a panel row or a log line. */
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
