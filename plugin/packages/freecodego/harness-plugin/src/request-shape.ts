/**
 * Request-shape fingerprinting for cache-break attribution.
 *
 * Why
 * ---
 * `cache-attribution.ts` attributes a miss *after the fact*, from the ledger: it
 * knows the previous prompt was not read back, and it can say whether the model
 * changed, the request came back past the TTL, or the prefix moved. That last
 * label is the one users hit most and the one it cannot explain — "the prefix
 * changed" is a symptom, not a cause.
 *
 * Claude Code's `promptCacheBreakDetection.ts` closes exactly this gap, and two
 * numbers from it set the priority. First, **77% of tool-schema cache breaks are
 * "tool prompt/schema changed, same tool set"** (their BQ 2026-03-22): the tool
 * list is identical and one tool's *description* moved — usually a tool that
 * embeds a dynamic list (their `AgentTool`/`SkillTool`, our `tool_search` index).
 * A count of added/removed tools cannot see that, which is why they hash each
 * tool separately and name the one that moved. Second, three separate flags had
 * been breaking the cache mid-session by *flipping*, and all three were fixed by
 * latching them ON for the session instead. That lesson is why this module names a
 * flip as a *cause* rather than tolerating it — and it is also why the plugin does
 * not ship a latch: a latch only helps a flag that can flip, and there is no
 * per-request header or capability bit here that flips mid-session. The fingerprint
 * below is what watches for one.
 *
 * This module is the pre-call half: fingerprint the request the Harness is about
 * to send, keep the previous fingerprint per conversation, and diff to name what
 * changed. It is pure — the caller decides when to snapshot and where to report.
 *
 * Why the Harness can do this at all: `session.requestHeader()` is the folded
 * `request/header` event, so it carries the *rendered* `system` text and the
 * *assembled* `tools` schemas of the last request. That is the wire shape, not a
 * guess at it, so a diff here names the same thing the provider cached on.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/request-shape
 */

import { createHash } from 'node:crypto'
import { stableJsonStrict } from './stable-json.ts'

/** One tool as it will appear on the wire. */
export interface ToolShapeEntry {
  readonly name: string
  readonly hash: string
  readonly chars: number
}

/**
 * The cache-relevant shape of one request.
 *
 * `systemHash` and `toolsHash` exist alongside the per-tool hashes because a
 * whole-block digest answers "did anything change" cheaply while the per-tool
 * map answers "what changed", and the second question is the expensive one.
 */
export interface RequestShape {
  readonly provider: string
  readonly model: string
  /** Digest of the rendered system text. */
  readonly systemHash: string
  readonly systemChars: number
  /** Digest over every tool's name and digest, order-insensitive by name. */
  readonly toolsHash: string
  readonly perTool: readonly ToolShapeEntry[]
  /** Sampling scalars that participate in the response, not the cache, but are diffed for completeness. */
  readonly reasoningEffort?: string | undefined
  readonly maxTokens?: number | undefined
}

/**
 * The single loudest reason a request's shape moved.
 *
 * One label for callers that need one, chosen in the order of what invalidates the
 * most: a model change matters more than a tool change, which matters more than the
 * system text. `initial` and `none` are answers too — a first request has nothing to
 * compare against, and a panel row that said "changed" for either would be wrong.
 */
export type ShapeChangeKind = 'initial' | 'none' | 'system' | 'tools' | 'model' | 'effort' | 'max-tokens'

/**
 * What moved between two request shapes, and whether it costs a cache miss.
 *
 * `causes` carries every reason rather than only the loudest one, because a request
 * that changed both its model and its tools has two independent fixes; `kind` is the
 * one-label answer for callers that cannot render a list.
 */
export interface ShapeChange {
  readonly kind: ShapeChangeKind
  /** Every cause that fired, in the order the reasons read best. */
  readonly causes: readonly string[]
  /** Tool names whose digest moved while the tool set stayed the same. */
  readonly changedTools: readonly string[]
  readonly addedTools: readonly string[]
  readonly removedTools: readonly string[]
  readonly systemCharDelta: number
  /** True when this change can invalidate the provider's cached prefix. */
  readonly cacheRelevant: boolean
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16)

/**
 * Key order must not depend on insertion order, or a schema rebuilt in a
 * different key order would read as a change and send someone chasing a cache
 * break that never happened.
 *
 * A reference cycle is reported instead of recursed into. A hand-written or
 * third-party JSONSchema can contain one (`properties.self = schema`), and the
 * failure it used to produce was an unlabelled `RangeError: Maximum call stack
 * size exceeded` from inside a hashing helper — the same class of defect the
 * plugin already fixed once for tool-result rendering. The caller wraps this in
 * a try/catch, so a labelled error means "no fingerprint this turn" rather than
 * a dead request.
 *
 * The encoding itself lives in `stable-json.ts`, shared with the doom-loop
 * guard's call fingerprint, so the two cannot drift apart again.
 */
const stableStringify = stableJsonStrict

/** Structural view of the Harness request header — only what a fingerprint needs. */
export interface RequestHeaderLike {
  readonly config?: {
    readonly provider?: unknown
    readonly model?: unknown
    readonly reasoningEffort?: unknown
    readonly maxTokens?: unknown
  } | undefined
  readonly system?: unknown
  readonly tools?: readonly { readonly name?: unknown; readonly description?: unknown; readonly parameters?: unknown }[] | undefined
}

/**
 * Fingerprint the request shape from a folded request header.
 *
 * Tool entries carry name, description and parameters — the three parts a
 * provider renders into the cached tool block.
 * @param header - the folded request header, or `undefined` before any request ran.
 * @returns The shape to compare against the next request's.
 */
export function fingerprintRequest(header: RequestHeaderLike | undefined): RequestShape {
  const config = header?.config
  const provider = typeof config?.provider === 'string' ? config.provider : 'unknown'
  const model = typeof config?.model === 'string' ? config.model : 'unknown'
  const system = typeof header?.system === 'string' ? header.system : ''
  const perTool: ToolShapeEntry[] = []
  for (const tool of header?.tools ?? []) {
    if (typeof tool.name !== 'string' || tool.name === '') continue
    const text = stableStringify({ description: tool.description ?? null, parameters: tool.parameters ?? null })
    perTool.push({ name: tool.name, hash: digest(text), chars: text.length })
  }
  perTool.sort((left, right) => left.name.localeCompare(right.name))
  return {
    provider,
    model,
    systemHash: digest(system),
    systemChars: system.length,
    // The join is order-independent by construction because `perTool` was sorted;
    // a reordered tool list must not read as a schema change.
    toolsHash: digest(perTool.map(entry => `${entry.name}\u0000${entry.hash}`).join('\u0001')),
    perTool,
    ...(typeof config?.reasoningEffort === 'string' ? { reasoningEffort: config.reasoningEffort } : {}),
    ...(typeof config?.maxTokens === 'number' ? { maxTokens: config.maxTokens } : {}),
  }
}

/**
 * Diff two fingerprints into a named cause list.
 *
 * `kind` is the single loudest cause for callers that need one label; `causes`
 * carries all of them, because a request that changed both its model and its
 * tools has two independent fixes and collapsing it to one hides the other.
 * @param previous - the shape recorded for this conversation, when there is one.
 * @param next - the shape just fingerprinted.
 * @returns The reasons, the affected tool names, and whether a cache can be affected.
 */
export function diffRequestShape(previous: RequestShape | undefined, next: RequestShape): ShapeChange {
  const changedTools: string[] = []
  const addedTools: string[] = []
  const removedTools: string[] = []
  let toolsChanged = false
  let systemCharDelta = 0

  if (previous === undefined) {
    return { kind: 'initial', causes: ['no previous request to compare against'], changedTools, addedTools, removedTools, systemCharDelta: 0, cacheRelevant: false }
  }

  const before = new Map(previous.perTool.map(entry => [entry.name, entry.hash]))
  const after = new Map(next.perTool.map(entry => [entry.name, entry.hash]))
  for (const [name, hash] of after) {
    const previousHash = before.get(name)
    if (previousHash === undefined) { addedTools.push(name); toolsChanged = true; continue }
    if (previousHash !== hash) { changedTools.push(name); toolsChanged = true }
  }
  for (const name of before.keys()) {
    if (!after.has(name)) { removedTools.push(name); toolsChanged = true }
  }
  changedTools.sort()
  addedTools.sort()
  removedTools.sort()

  const systemChanged = previous.systemHash !== next.systemHash
  if (systemChanged) systemCharDelta = next.systemChars - previous.systemChars
  const modelChanged = previous.model !== next.model || previous.provider !== next.provider
  const effortChanged = previous.reasoningEffort !== next.reasoningEffort
  const maxTokensChanged = previous.maxTokens !== next.maxTokens

  const causes: string[] = []
  if (modelChanged) causes.push(`model changed (${previous.provider}/${previous.model} → ${next.provider}/${next.model})`)
  if (systemChanged) {
    const delta = systemCharDelta === 0 ? '' : systemCharDelta > 0 ? ` (+${systemCharDelta} chars)` : ` (${systemCharDelta} chars)`
    causes.push(`system prompt changed${delta}`)
  }
  if (toolsChanged) {
    if (addedTools.length > 0 || removedTools.length > 0) {
      causes.push(`tool set changed (+${addedTools.length}/-${removedTools.length})`)
    } else {
      causes.push(`tool schema changed with the same tool set: ${changedTools.join(', ')}`)
    }
  }
  if (effortChanged) causes.push(`reasoning effort changed (${previous.reasoningEffort ?? 'default'} → ${next.reasoningEffort ?? 'default'})`)
  if (maxTokensChanged) causes.push(`max tokens changed (${previous.maxTokens ?? 'default'} → ${next.maxTokens ?? 'default'})`)

  const kind: ShapeChangeKind = modelChanged ? 'model'
    : toolsChanged ? 'tools'
      : systemChanged ? 'system'
        : effortChanged ? 'effort'
          : maxTokensChanged ? 'max-tokens'
            : 'none'

  return {
    kind,
    causes,
    changedTools,
    addedTools,
    removedTools,
    systemCharDelta,
    // Sampling scalars do not participate in the cached prefix; everything else here does.
    cacheRelevant: modelChanged || systemChanged || toolsChanged,
  }
}

/**
 * One-line explanation for a log line or a panel row.
 * @param change - the diff to describe.
 * @returns A sentence naming every cause, or that nothing changed.
 */
export function describeShapeChange(change: ShapeChange): string {
  if (change.kind === 'initial') return 'first request for this conversation; nothing to compare'
  if (change.kind === 'none') return 'request shape unchanged'
  return change.causes.join('; ')
}

/**
 * Per-conversation request-shape memory, with a hard cap.
 *
 * The cap matters more than it looks: each entry holds a full system digest and
 * every tool digest, and a fleet of subagents each gets its own key. Without it
 * the map grows with the number of agents ever spawned.
 */
export class RequestShapeLog {
  private readonly shapes = new Map<string, RequestShape>()

  constructor(private readonly maxEntries = 10) {}

  /**
   * Diff against the stored shape and store the new one.
   *
   * The key is re-inserted on every record so eviction drops the conversation that
   * has gone longest without a request, not the one created first — a long-lived
   * session must not lose its shape because it started early.
   * @param key - the conversation this request belongs to.
   * @param next - the shape just fingerprinted.
   * @returns What changed since that conversation's last request.
   */
  record(key: string, next: RequestShape): ShapeChange {
    const change = diffRequestShape(this.shapes.get(key), next)
    // Re-insert so the newest key is last, then evict the oldest beyond the cap.
    this.shapes.delete(key)
    this.shapes.set(key, next)
    while (this.shapes.size > this.maxEntries) {
      const oldest = this.shapes.keys().next()
      if (oldest.done === true) break
      this.shapes.delete(oldest.value)
    }
    return change
  }

  /**
   * Last recorded shape for a key, without recording.
   * @param key - the conversation to look up.
   * @returns Its last shape, or `undefined` when none was recorded.
   */
  peek(key: string): RequestShape | undefined {
    return this.shapes.get(key)
  }

  /**
   * Drop one conversation's shape, so its next request is read as a first one.
   * @param key - the conversation whose memory is being dropped.
   */
  forget(key: string): void {
    this.shapes.delete(key)
  }

  /** Drop every remembered shape. */
  clear(): void {
    this.shapes.clear()
  }
}
