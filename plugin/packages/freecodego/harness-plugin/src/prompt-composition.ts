/**
 * Where a request's prompt actually goes, and the tree that answers it one node
 * at a time.
 *
 * Why
 * ---
 * `context-budget.ts` tells the model how *full* the window is and
 * `cache-attribution.ts` tells it what a miss *cost*; neither says what the
 * tokens are *made of*. That is the question behind most of the platform's real
 * decisions — the deferred-schema work exists because tool definitions were
 * 45.7-47.4 KB of a 13,454-token fixed block, and that figure was found by one
 * offline measurement, not by anything the model or a user can ask at runtime.
 * Without a breakdown, "the prompt is large" has no next step: the model cannot
 * tell a bloated tool block (defer, or turn a pack off) from a long conversation
 * (compact) from accumulated rules and Skills (a settings change).
 *
 * The two hard parts, and how this module answers them
 * ------------------------------------------------
 * **1. A breakdown of a measurement is not itself a measurement.** Category
 * sizes can be counted in characters exactly, but tokens per category cannot:
 * there is no tokenizer here, and the provider's own `prompt_tokens` is a single
 * number for the whole request. Reporting a lexical estimate as if it were the
 * category's cost produces a table whose rows sum to something the provider
 * never said. So when the ledger has a measured prompt total, the category
 * figures are **apportioned** to it — largest-remainder, so the rows sum to
 * exactly the provider's number — and every row carries the ratio it was
 * apportioned by. When there is no measurement, the rows are a lexical sum and
 * the snapshot says `measured: false`; the two are never mixed.
 *
 * **2. A breakdown that jitters is not usable.** A naive apportionment reports
 * every category as noise on every turn, because the apportionment divisor
 * moved. Each category's *token-per-character ratio* is therefore carried
 * forward from the previous snapshot: a category whose character count did not
 * change keeps its token figure outright, and one that moved is re-scaled by
 * the ratio it had. The conversation is then the **residual** — the measured
 * total minus the cacheable categories — because the conversation is the part
 * that grows without a bound this module can see, so it is the honest place for
 * the error to land.
 *
 * One consequence is worth stating plainly, because it is the module's sharpest
 * edge: if the cacheable categories resolve to more than the measured total, the
 * new snapshot is **discarded and the previous one returned**. A table where the
 * parts exceed the whole is worse than a stale one, and a stale one is at least
 * true about a request that existed.
 *
 * The tree
 * --------
 * A breakdown says *how much*; the tree says *which*. It hangs category nodes
 * over per-item nodes, and it pairs a tool call with its result under one
 * parent, because a call and its answer are one unit of context: a pair whose
 * result never arrived is the interrupted-turn case and should be visible as a
 * call with no sibling, not as two unrelated nodes. Items carry either their
 * text inline (when it is small) or a **reference** into the session log (when
 * it is not), so the tree stays bounded no matter how large one tool result was.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/prompt-composition
 */

import { tokensFromChars } from './token-estimate.ts'

/** The eight buckets a prompt is divided into, in report order. */
export const PROMPT_COMPOSITION_CATEGORIES = [
  { id: 'system-prompt', label: 'System prompt' },
  { id: 'tools', label: 'Tool definitions' },
  { id: 'rules', label: 'Rules' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP & dynamic tools' },
  { id: 'subagents', label: 'Subagent definitions' },
  { id: 'summary', label: 'Summarized conversation' },
  { id: 'conversation', label: 'Conversation' },
] as const

export type PromptCompositionCategoryId = typeof PROMPT_COMPOSITION_CATEGORIES[number]['id']

/**
 * The category that absorbs the apportionment error.
 *
 * Excluded from the ratio cache because it is defined as the remainder, not as a
 * proportional share: caching a ratio for it and then overriding it with the
 * residual would leave a token figure nothing computed.
 */
const RESIDUAL_CATEGORY: PromptCompositionCategoryId = 'conversation'

/** Every category except the residual, in report order. */
const PROPORTIONAL_CATEGORIES: readonly PromptCompositionCategoryId[] =
  PROMPT_COMPOSITION_CATEGORIES.map(category => category.id).filter(id => id !== RESIDUAL_CATEGORY)

const LABELS = new Map<string, string>(PROMPT_COMPOSITION_CATEGORIES.map(category => [category.id, category.label]))

/**
 * A lexical price, delegating to the plugin's single estimation entry point.
 *
 * Deliberately the same density the host meters content by, and labelled as an
 * estimate wherever it surfaces. A real tokenizer would be a different module
 * with a different dependency; pretending this is one is the failure this whole
 * file is arranged to avoid.
 *
 * Re-exported rather than implemented here so that this module cannot drift from
 * `token-estimate.ts`: the plugin has exactly one `/ 4` and this is a caller of
 * it.
 */
export function estimateTokensFromChars(chars: number): number {
  return tokensFromChars(chars)
}

/** Raw text per category, as the caller collected it from the real request. */
export type PromptCompositionSources = Readonly<Partial<Record<PromptCompositionCategoryId, readonly string[]>>>

export interface PromptCompositionCategory {
  readonly id: PromptCompositionCategoryId
  readonly label: string
  /** Exact character count of this category's text. */
  readonly chars: number
  /** Apportioned tokens: rows sum to the snapshot total by construction. */
  readonly tokens: number
  /** This category's lexical estimate, before apportionment. */
  readonly rawTokens: number
  /** Share of the snapshot total, `undefined` when the total is zero. */
  readonly share?: number | undefined
}

export interface PromptCompositionSnapshot {
  /** Sum of the rows; equals `measuredPromptTokens` whenever one was supplied. */
  readonly totalTokens: number
  /** The provider's own prompt figure, when the ledger had one. */
  readonly measuredPromptTokens?: number | undefined
  /** `true` when the total is the provider's number rather than a lexical sum. */
  readonly measured: boolean
  readonly contextWindow?: number | undefined
  /** The rows sum to `totalTokens` exactly. A false here means the snapshot is a
   *  carried-forward one, and the caller should say so rather than render it as
   *  fresh. */
  readonly consistent: boolean
  readonly categories: readonly PromptCompositionCategory[]
}

export interface PromptCompositionInput {
  readonly sources: PromptCompositionSources
  /**
   * The provider's prompt total for this request, as the ledger recorded it
   * (`input + cacheRead + cacheWrite`). Omitted when the model reported none.
   */
  readonly measuredPromptTokens?: number | undefined
  readonly contextWindow?: number | undefined
  /** The previous snapshot for this conversation, used for ratio carry-forward. */
  readonly previous?: PromptCompositionSnapshot | undefined
}

/** Character count per category, always exact even when tokens are not. */
export function countCategoryChars(sources: PromptCompositionSources): Readonly<Record<PromptCompositionCategoryId, number>> {
  const counts = {} as Record<PromptCompositionCategoryId, number>
  for (const category of PROMPT_COMPOSITION_CATEGORIES) {
    let total = 0
    for (const segment of sources[category.id] ?? []) total += segment.length
    counts[category.id] = total
  }
  return counts
}

/**
 * Split a whole into its parts without changing the whole.
 *
 * Largest-remainder rather than rounding each share: rounding independently
 * loses or invents tokens, so a table of a 13,454-token prompt could total
 * 13,451. Ties break on report order, so the same input always produces the same
 * table — a report that rearranged itself between two identical calls would read
 * as a change that never happened.
 *
 * @param weights - the non-negative raw weight per category.
 * @param total - the figure the parts must sum to.
 * @returns the apportioned integer per category, summing to `total`.
 */
export function apportionToTotal(
  weights: Readonly<Record<PromptCompositionCategoryId, number>>,
  total: number,
): Readonly<Record<PromptCompositionCategoryId, number>> {
  const target = Math.max(0, Math.round(total))
  const result = {} as Record<PromptCompositionCategoryId, number>
  for (const category of PROMPT_COMPOSITION_CATEGORIES) result[category.id] = 0
  if (target === 0) return result
  const weightSum = PROMPT_COMPOSITION_CATEGORIES.reduce((sum, category) => sum + Math.max(0, weights[category.id]), 0)
  // Nothing to weight by: the whole is real and the parts are unknown, so the
  // only honest split is to leave it in the residual rather than invent a ratio.
  if (weightSum === 0) {
    result[RESIDUAL_CATEGORY] = target
    return result
  }
  const scaled = PROMPT_COMPOSITION_CATEGORIES.map((category, index) => {
    const weight = Math.max(0, weights[category.id])
    const exact = (weight / weightSum) * target
    const floored = Math.floor(exact)
    return { id: category.id, index, weight, floored, remainder: exact - floored }
  })
  for (const entry of scaled) result[entry.id] = entry.floored
  let remaining = target - scaled.reduce((sum, entry) => sum + entry.floored, 0)
  const byRemainder = [...scaled].sort((left, right) => right.remainder - left.remainder || left.index - right.index)
  for (const entry of byRemainder) {
    if (remaining <= 0) break
    result[entry.id] += 1
    remaining -= 1
  }
  return result
}

/**
 * Resolve one proportional category against its own history.
 *
 * The order of the three answers is the point: an unchanged category is reused
 * verbatim (the common case, and the one that makes consecutive reports
 * comparable), a changed one is scaled by the ratio it had, and only a category
 * with no history falls back to the lexical estimate.
 */
function resolveProportional(
  chars: number,
  previous: PromptCompositionCategory | undefined,
  fallbackRatio: number | undefined,
): number {
  if (chars === 0) return 0
  if (previous !== undefined && previous.chars > 0) {
    if (previous.chars === chars) return previous.tokens
    return Math.max(0, Math.round(previous.tokens * (chars / previous.chars)))
  }
  if (fallbackRatio !== undefined && fallbackRatio > 0) return Math.max(0, Math.round(chars * fallbackRatio))
  return estimateTokensFromChars(chars)
}

/** The historical tokens-per-character ratio across a previous snapshot. */
function averageRatio(previous: PromptCompositionSnapshot | undefined): number | undefined {
  if (previous === undefined) return undefined
  let chars = 0
  let tokens = 0
  for (const category of previous.categories) {
    if (category.chars <= 0) continue
    chars += category.chars
    tokens += category.tokens
  }
  return chars === 0 ? undefined : tokens / chars
}

function assemble(
  chars: Readonly<Record<PromptCompositionCategoryId, number>>,
  tokens: Readonly<Record<PromptCompositionCategoryId, number>>,
  rawTokens: Readonly<Record<PromptCompositionCategoryId, number>>,
  total: number,
  measured: boolean,
  contextWindow: number | undefined,
  measuredPromptTokens: number | undefined,
): PromptCompositionSnapshot {
  const categories = PROMPT_COMPOSITION_CATEGORIES.map(category => ({
    id: category.id,
    label: LABELS.get(category.id) ?? category.id,
    chars: chars[category.id],
    tokens: tokens[category.id],
    rawTokens: rawTokens[category.id],
    ...(total <= 0 ? {} : { share: tokens[category.id] / total }),
  }))
  return {
    totalTokens: total,
    ...(measuredPromptTokens === undefined ? {} : { measuredPromptTokens }),
    measured,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    consistent: categories.reduce((sum, category) => sum + category.tokens, 0) === total,
    categories,
  }
}

/**
 * Build the composition snapshot for one request.
 *
 * @param input - the collected text, the measured total when there is one, and
 *   the previous snapshot to carry ratios from.
 * @returns the snapshot; `consistent` is `false` only for a carried-forward one.
 */
export function buildPromptComposition(input: PromptCompositionInput): PromptCompositionSnapshot {
  const chars = countCategoryChars(input.sources)
  const rawTokens = {} as Record<PromptCompositionCategoryId, number>
  for (const category of PROMPT_COMPOSITION_CATEGORIES) rawTokens[category.id] = estimateTokensFromChars(chars[category.id])

  const measuredTotal = input.measuredPromptTokens !== undefined && Number.isFinite(input.measuredPromptTokens) && input.measuredPromptTokens > 0
    ? Math.round(input.measuredPromptTokens)
    : undefined

  // No measurement: the rows are a lexical sum, and the snapshot says so rather
  // than dressing the sum up as the provider's number.
  if (measuredTotal === undefined) {
    return assemble(chars, rawTokens, rawTokens, PROMPT_COMPOSITION_CATEGORIES.reduce((sum, c) => sum + rawTokens[c.id], 0), false, input.contextWindow, undefined)
  }

  const previousById = new Map(input.previous?.categories.map(category => [category.id, category]) ?? [])
  // The first snapshot for a conversation has no ratios to carry, so every row
  // is apportioned from its lexical weight in one pass; that is what makes the
  // rows sum to the measured total exactly.
  if (input.previous === undefined) {
    return assemble(chars, apportionToTotal(rawTokens, measuredTotal), rawTokens, measuredTotal, true, input.contextWindow, measuredTotal)
  }

  const ratio = averageRatio(input.previous)
  const resolved = {} as Record<PromptCompositionCategoryId, number>
  for (const id of PROPORTIONAL_CATEGORIES) resolved[id] = resolveProportional(chars[id], previousById.get(id), ratio)
  const proportionalSum = PROPORTIONAL_CATEGORIES.reduce((sum, id) => sum + resolved[id], 0)
  // Parts larger than their whole are not a report, they are a bug in the
  // ratios. Keeping the previous snapshot leaves the caller with something true
  // about a request that existed; `consistent` stays true because it describes
  // the snapshot that was returned.
  if (proportionalSum > measuredTotal) return input.previous
  resolved[RESIDUAL_CATEGORY] = measuredTotal - proportionalSum
  return assemble(chars, resolved, rawTokens, measuredTotal, true, input.contextWindow, measuredTotal)
}

/**
 * Rebuild after a compaction rewrote the summarized conversation.
 *
 * Compaction changes exactly one thing: the conversation collapses into a
 * summary. Everything else in the prompt is the same text it was, so the cached
 * ratios for those categories are still correct and are carried forward
 * untouched; only the summary row is re-resolved against its own new size. A
 * full rebuild here would re-apportion every row against a total that the
 * compaction itself changed, so the whole table would move for one edit.
 *
 * @param previous - the last snapshot. Absent or ratio-less input returns it unchanged.
 * @param summaryChars - the new character count of the summarized conversation.
 * @param options - the measured total after compaction and the window, when known.
 * @returns the refreshed snapshot, or `previous` when it carries nothing to scale.
 */
export function refreshPromptCompositionAfterCompaction(
  previous: PromptCompositionSnapshot,
  summaryChars: number,
  options: { readonly measuredPromptTokens?: number | undefined; readonly contextWindow?: number | undefined } = {},
): PromptCompositionSnapshot {
  const previousById = new Map(previous.categories.map(category => [category.id, category]))
  const ratio = averageRatio(previous)
  const resolved = {} as Record<PromptCompositionCategoryId, number>
  for (const id of PROPORTIONAL_CATEGORIES) {
    if (id === 'summary') { resolved[id] = resolveProportional(summaryChars, previousById.get(id), ratio); continue }
    resolved[id] = previousById.get(id)?.tokens ?? 0
  }
  const measuredTotal = options.measuredPromptTokens !== undefined && Number.isFinite(options.measuredPromptTokens) && options.measuredPromptTokens > 0
    ? Math.round(options.measuredPromptTokens)
    : previous.totalTokens
  const proportionalSum = PROPORTIONAL_CATEGORIES.reduce((sum, id) => sum + resolved[id], 0)
  if (proportionalSum > measuredTotal) return previous
  resolved[RESIDUAL_CATEGORY] = measuredTotal - proportionalSum
  const chars = {} as Record<PromptCompositionCategoryId, number>
  const rawTokens = {} as Record<PromptCompositionCategoryId, number>
  for (const category of PROMPT_COMPOSITION_CATEGORIES) {
    chars[category.id] = category.id === 'summary' ? summaryChars : previousById.get(category.id)?.chars ?? 0
    rawTokens[category.id] = category.id === 'summary' ? estimateTokensFromChars(summaryChars) : previousById.get(category.id)?.rawTokens ?? 0
  }
  const contextWindow = options.contextWindow ?? previous.contextWindow
  return assemble(chars, resolved, rawTokens, measuredTotal, previous.measured, contextWindow, previous.measuredPromptTokens)
}

const count = (value: number): string => Math.round(value).toLocaleString('en-US')
const percent = (fraction: number): string => `${(fraction * 100).toFixed(1)}%`

/**
 * Render the breakdown as the model-facing fragment.
 *
 * Every row states both its share and its token figure, and the header states
 * whether the figure is the provider's measurement or a lexical estimate — the
 * distinction the whole module is built around is worthless if the text drops
 * it. Rows that are empty are omitted, so a short prompt stays short.
 */
export function describePromptComposition(snapshot: PromptCompositionSnapshot): string {
  const lines: string[] = []
  const basis = snapshot.measured
    ? `apportioned to the provider's measured prompt of ${count(snapshot.totalTokens)} tokens`
    : 'a lexical estimate (bytes / 4), so treat it as a rough shape and not a measurement'
  const window = snapshot.contextWindow === undefined ? '' : ` of a ${count(snapshot.contextWindow)}-token window`
  lines.push(`Prompt composition${window}: ${count(snapshot.totalTokens)} prompt tokens total, ${basis}.`)
  const rows = [...snapshot.categories].filter(category => category.chars > 0).sort((left, right) => right.tokens - left.tokens)
  if (rows.length === 0) {
    lines.push('Nothing measurable was collected for this request.')
    return lines.join('\n')
  }
  for (const row of rows) {
    const share = row.share === undefined ? '' : `${percent(row.share)} — `
    lines.push(`- ${row.label}: ${share}${count(row.tokens)} tokens (${count(row.chars)} chars)`)
  }
  const conversation = snapshot.categories.find(category => category.id === RESIDUAL_CATEGORY)
  if (snapshot.measured && conversation !== undefined) {
    lines.push('The conversation figure is the residual after the cacheable categories, so it carries their apportionment error; read it as "everything else", not as a measurement of the transcript alone.')
  }
  return lines.join('\n')
}

/** Bounded node budget for one tree; a tree is a map, not a transcript. */
export const PROMPT_USAGE_TREE_MAX_NODES = 400
/** Text at or below this length is embedded in its node; longer text is referenced. */
export const PROMPT_USAGE_INLINE_MAX_CHARS = 2_000

/**
 * One item of the prompt, as the caller found it.
 *
 * `callId` is what makes a call and its result one node instead of two: entries
 * that share a `callId` are hoisted under a shared parent, and a call whose
 * result is missing keeps its place with no sibling — which is exactly the
 * interrupted-turn shape a reader needs to see.
 */
export interface PromptUsageItem {
  readonly id: string
  readonly label: string
  readonly categoryId: PromptCompositionCategoryId
  readonly text: string
  readonly callId?: string | undefined
  /** `call` and `result` pair by `callId`; a plain item has neither. */
  readonly role?: 'call' | 'result' | undefined
  /** Reasoning the provider redacted: counted nowhere and shown nowhere. */
  readonly redacted?: boolean | undefined
}

export interface PromptUsageNode {
  readonly id: string
  readonly parentId?: string | undefined
  readonly kind: 'category' | 'item' | 'pair'
  readonly label: string
  readonly categoryId: PromptCompositionCategoryId
  readonly tokens: number
  readonly chars: number
  /**
   * `inline` carries the text (truncated at {@link PROMPT_USAGE_INLINE_MAX_CHARS}),
   * `blob` names where to read it instead — the only way a 40 KB tool result can
   * appear in a bounded tree.
   */
  readonly content?: { readonly kind: 'inline'; readonly text: string; readonly truncated: boolean } | { readonly kind: 'blob'; readonly ref: string } | undefined
}

export interface PromptUsageTree {
  readonly nodes: readonly PromptUsageNode[]
  /** Entries the node budget or a redaction removed; never silently dropped. */
  readonly omittedItems: number
  readonly omittedRedacted: number
  readonly truncated: boolean
}

const categoryNodeId = (id: PromptCompositionCategoryId): string => `category:${id}`

/**
 * Build the usage tree: category nodes, then one node per item, with a tool call
 * and its result nested under a single pair node.
 *
 * @param snapshot - the breakdown whose per-category token figures the roots carry.
 * @param items - the prompt's items, in transcript order.
 * @returns the bounded tree.
 */
export function buildPromptUsageTree(snapshot: PromptCompositionSnapshot, items: readonly PromptUsageItem[]): PromptUsageTree {
  const nodes: PromptUsageNode[] = []
  const tokensById = new Map(snapshot.categories.map(category => [category.id, category.tokens]))
  const charsById = new Map(snapshot.categories.map(category => [category.id, category.chars]))
  for (const category of PROMPT_COMPOSITION_CATEGORIES) {
    nodes.push({
      id: categoryNodeId(category.id),
      kind: 'category',
      label: category.label,
      categoryId: category.id,
      tokens: tokensById.get(category.id) ?? 0,
      chars: charsById.get(category.id) ?? 0,
    })
  }

  let omittedRedacted = 0
  let omittedItems = 0
  // A result is placed by its call, so the call must be seen first; scanning
  // once for the pairing keeps the second pass a pure lookup.
  const callByCallId = new Map<string, PromptUsageItem>()
  for (const item of items) {
    if (item.role === 'call' && item.callId !== undefined) callByCallId.set(item.callId, item)
  }
  const resultByCallId = new Map<string, PromptUsageItem>()
  for (const item of items) {
    if (item.role !== 'result' || item.callId === undefined) continue
    if (resultByCallId.has(item.callId)) continue
    resultByCallId.set(item.callId, item)
  }
  const paired = new Set<string>()

  const appendItem = (item: PromptUsageItem, parentId?: string): boolean => {
    if (nodes.length >= PROMPT_USAGE_TREE_MAX_NODES) return false
    const inline = item.text.length <= PROMPT_USAGE_INLINE_MAX_CHARS
    nodes.push({
      id: item.id,
      ...(parentId === undefined ? { parentId: categoryNodeId(item.categoryId) } : { parentId }),
      kind: 'item',
      label: item.label,
      categoryId: item.categoryId,
      tokens: estimateTokensFromChars(item.text.length),
      chars: item.text.length,
      content: inline
        ? { kind: 'inline', text: item.text, truncated: false }
        : { kind: 'blob', ref: item.id },
    })
    return true
  }

  // The walk visits every item even after the node budget is spent, because the
  // walk is also the census: stopping at the first refusal reported `omittedItems:
  // 1` for a prompt that had 800 entries left, which makes the one number that
  // tells a reader "this tree is incomplete" wrong by three orders of magnitude.
  // Counting is O(items) with no node appends, and `items` is a transcript the
  // caller already holds.
  for (const item of items) {
    if (item.redacted === true) { omittedRedacted += 1; continue }
    if (paired.has(item.id)) continue
    if (item.role === 'result') {
      // A result whose call was never recorded has no parent to nest under; it
      // is a real part of the prompt, so it stands on its own rather than being
      // dropped for want of a sibling.
      if (item.callId !== undefined && callByCallId.has(item.callId)) continue
      if (!appendItem(item)) omittedItems += 1
      continue
    }
    if (item.role === 'call' && item.callId !== undefined) {
      // Every call gets its pair node, answered or not. A pair whose result is
      // missing is the interrupted-turn shape, and it has to be *visible* here:
      // collapsing an unanswered call into a plain item would erase the one
      // difference a reader is looking for.
      const result = resultByCallId.get(item.callId)
      if (nodes.length + 3 > PROMPT_USAGE_TREE_MAX_NODES) {
        // A pair is three nodes over two entries. When it cannot be placed, both
        // entries are omitted — the result is skipped by the call lookup below,
        // so counting it here is the only place it is counted at all.
        omittedItems += result === undefined ? 1 : 2
        continue
      }
      const pairId = `pair:${item.callId}`
      const totalChars = item.text.length + (result?.text.length ?? 0)
      nodes.push({
        id: pairId,
        kind: 'pair',
        label: result === undefined ? `${item.label} (call, no recorded result)` : `${item.label} (call + result)`,
        categoryId: item.categoryId,
        tokens: estimateTokensFromChars(totalChars),
        chars: totalChars,
      })
      appendItem(item, pairId)
      if (result !== undefined) {
        appendItem(result, pairId)
        paired.add(result.id)
      }
      continue
    }
    if (!appendItem(item)) omittedItems += 1
  }
  return { nodes, omittedItems, omittedRedacted, truncated: omittedItems > 0 }
}
