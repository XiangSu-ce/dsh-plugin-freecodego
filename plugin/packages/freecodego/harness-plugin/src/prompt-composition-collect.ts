/**
 * Project the Harness's own request header and session events into the
 * prompt-composition inputs.
 *
 * Why this is separate from the calculator
 * ---------------------------------------
 * `prompt-composition.ts` is arithmetic over text; it must not learn the shape of
 * a session log to stay testable. This module is the other half: the one place
 * that knows which tag belongs to which bucket and which event is a message.
 * Keeping the mapping here also keeps it in one place to audit when an upstream
 * module starts rendering a new block.
 *
 * Two rules the mapping follows
 * ----------------------------
 * **1. Tagged blocks are counted where they belong, and stripped from the
 * conversation.** A Skills catalog that arrives inside a user message is not
 * conversation; counting it as both would double the bucket whose size is the
 * whole reason the breakdown exists. So a block is moved, not copied — the
 * conversation text is what remains after every recognised block is removed.
 *
 * **2. An unrecognised tag stays in the conversation.** A block nobody classified
 * is still prompt text, and dropping it would make the rows under-count the
 * prompt while looking complete. The row that grows a little too large is a much
 * smaller error than a category that silently disappears.
 *
 * Which events carry the summarized conversation
 * ---------------------------------------------
 * The `summary` bucket has two possible sources and this module reads the
 * durable one. Compaction commits a `compaction/summary` event whose `summary`
 * is the replacement text, and that is what the Harness writes — a summary
 * arrives as a *session event*, not as a message in the transcript. The
 * marker-based `user/message` detection is kept for a composition that folds it
 * into a message instead, and the durable event takes precedence when both are
 * present so the same characters are never counted twice. Reading only the
 * message shape was the reason the `summary` row was structurally zero in this
 * composition: the label, its apportionment share, and a whole
 * post-compaction refresh existed for a bucket nothing ever filled.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/prompt-composition-collect
 */

import type { PromptCompositionCategoryId, PromptCompositionSources, PromptUsageItem } from './prompt-composition.ts'

/** Structural view of the folded request header — only what the breakdown reads. */
export interface PromptHeaderLike {
  readonly system?: unknown
  readonly tools?: readonly { readonly name?: unknown; readonly description?: unknown; readonly parameters?: unknown }[] | undefined
  readonly config?: { readonly model?: unknown; readonly provider?: unknown } | undefined
}

/** Structural view of one durability event. */
export interface PromptEventLike {
  readonly type?: unknown
  readonly seq?: unknown
  readonly time?: unknown
  readonly data?: unknown
}

/**
 * Tags the breakdown knows, mapped to the bucket they belong in.
 *
 * Every entry is a tag this codebase actually renders: `freecodego-skill-map` is
 * this plugin's own session-start catalog, and the `skill_*` / `available_skills`
 * set is what `@deepseek-ai/dsh-skill` wraps a loaded Skill in.
 */
const TAGGED_BLOCK_CATEGORIES: readonly { readonly tag: string | RegExp; readonly categoryId: PromptCompositionCategoryId }[] = [
  { tag: 'freecodego-skill-map', categoryId: 'skills' },
  { tag: 'available_skills', categoryId: 'skills' },
  { tag: 'skill_instructions', categoryId: 'skills' },
  { tag: 'skill_resources', categoryId: 'skills' },
  { tag: 'rules', categoryId: 'rules' },
  { tag: 'available_subagent_types', categoryId: 'subagents' },
  { tag: 'available_subagent_models', categoryId: 'subagents' },
  { tag: /^mcp_/u, categoryId: 'mcp' },
  { tag: /^dynamic_tool/u, categoryId: 'mcp' },
]

const categoryForTag = (tag: string): PromptCompositionCategoryId | undefined =>
  TAGGED_BLOCK_CATEGORIES.find(entry => typeof entry.tag === 'string' ? entry.tag === tag : entry.tag.test(tag))?.categoryId

interface TagRange { readonly start: number; readonly end: number; readonly tag: string }

/**
 * Every complete `<tag>...</tag>` range in a text, outermost first.
 *
 * Incomplete ranges are deliberately ignored: a half-streamed block must not be
 * classified as though it had been closed, and the text it did contribute stays
 * in the conversation where it is harmless.
 */
function tagRanges(text: string, name: string): readonly TagRange[] {
  const ranges: TagRange[] = []
  const open = new RegExp(`<${name}(?:\\s[^>]*)?>`, 'gu')
  const close = new RegExp(`</${name}\\s*>`, 'gu')
  const opens = [...text.matchAll(open)]
  for (const match of opens) {
    const from = match.index + match[0].length
    close.lastIndex = from
    const end = close.exec(text)
    if (end === null) continue
    ranges.push({ start: match.index, end: end.index + end[0].length, tag: name })
  }
  return ranges
}

/** Every tag name that appears as an opening tag in a text, deduplicated. */
function tagNames(text: string): readonly string[] {
  return [...new Set([...text.matchAll(/<([a-z][a-z0-9_-]*)(?:\s[^>]*)?>/gu)].map(match => match[1]!))]
}

/** Keep the outermost of any nested ranges, so a block is moved once. */
function outermost(ranges: readonly TagRange[]): readonly TagRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || right.end - left.end)
  const selected: TagRange[] = []
  let coveredUntil = -1
  for (const range of sorted) {
    if (range.start < coveredUntil) continue
    selected.push(range)
    coveredUntil = range.end
  }
  return selected
}

/**
 * Split one text into the blocks it carries and the conversation text left over.
 *
 * @param text - the message text.
 * @returns the recognised blocks by category, plus the text with them removed.
 */
export function segmentPromptText(text: string): { readonly blocks: Readonly<Partial<Record<PromptCompositionCategoryId, readonly string[]>>>; readonly remainder: string } {
  if (text === '') return { blocks: {}, remainder: '' }
  const found: TagRange[] = []
  for (const name of tagNames(text)) {
    if (categoryForTag(name) === undefined) continue
    found.push(...tagRanges(text, name))
  }
  const selected = outermost(found)
  const blocks: Partial<Record<PromptCompositionCategoryId, string[]>> = {}
  for (const range of selected) {
    const category = categoryForTag(range.tag)
    if (category === undefined) continue
    ;(blocks[category] ??= []).push(text.slice(range.start, range.end))
  }
  let remainder = ''
  let cursor = 0
  for (const range of selected) {
    remainder += text.slice(cursor, range.start)
    cursor = range.end
  }
  remainder += text.slice(cursor)
  return { blocks, remainder }
}

/**
 * The text of one message's content, joined.
 *
 * Recursive because a tool result nests: a `tool-result` block carries its own
 * `content` array, so a one-level read would price every tool result at zero and
 * make the transcript look small precisely when it is not. Depth is bounded so a
 * self-referential payload cannot walk forever, and the depth bound is the only
 * thing that is dropped — not the caller's data.
 *
 * @param content - a message's content, or one nested block's.
 * @param depth - remaining recursion budget; internal.
 * @returns the concatenated text of every text-bearing part.
 */
function messageText(content: unknown, depth = 4): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content) || depth <= 0) return ''
  const parts: string[] = []
  for (const part of content) {
    if (typeof part === 'string') { parts.push(part); continue }
    if (typeof part !== 'object' || part === null) continue
    const record = part as { readonly text?: unknown; readonly content?: unknown; readonly result?: unknown; readonly args?: unknown; readonly input?: unknown }
    if (typeof record.text === 'string') { parts.push(record.text); continue }
    if (record.content !== undefined) { const nested = messageText(record.content, depth - 1); if (nested !== '') parts.push(nested) }
    for (const value of [record.result, record.args, record.input]) {
      if (typeof value === 'string') { parts.push(value); continue }
      if (value === undefined || value === null) continue
      try { parts.push(JSON.stringify(value)) } catch { /* a non-serializable payload contributes no text */ }
    }
  }
  return parts.join('\n')
}

/** Whether one event is the compaction summary carrier rather than a real turn. */
function isSummaryEvent(data: Record<string, unknown>): boolean {
  const message = data.message as { readonly source?: { readonly kind?: unknown } } | undefined
  if (message?.source?.kind === 'compaction') return true
  const text = messageText((message as { readonly content?: unknown } | undefined)?.content)
  return text.startsWith('<summary>') || text.includes('<compacted-conversation')
}

/**
 * Collect the breakdown's text from a request header and the session log.
 *
 * The header supplies the two buckets that live outside the transcript
 * (`system-prompt` and `tools`, rendered exactly as they go on the wire), and the
 * log supplies everything else. Both are the real artifacts rather than a
 * reconstruction, which is the only way the rows can be trusted to describe the
 * request the provider actually saw.
 *
 * @param header - the folded request header, when the session has one.
 * @param events - the session's events, oldest first.
 * @returns the text per category.
 */
export function collectPromptCompositionSources(header: PromptHeaderLike | undefined, events: readonly PromptEventLike[]): PromptCompositionSources {
  const sources: Partial<Record<PromptCompositionCategoryId, string[]>> = {}
  const push = (id: PromptCompositionCategoryId, text: string): void => {
    if (text === '') return
    ;(sources[id] ??= []).push(text)
  }

  if (typeof header?.system === 'string') push('system-prompt', header.system)
  for (const tool of header?.tools ?? []) {
    if (typeof tool.name !== 'string' || tool.name === '') continue
    // The three parts a provider renders into its cached tool block. The schema is
    // serialized the same way `request-shape.ts` hashes it, so a tool that moved
    // in one report moved in the other.
    push('tools', `${tool.name} ${String(tool.description ?? '')} ${JSON.stringify(tool.parameters ?? null)}`)
  }

  //
  // The summary arrives in one of two shapes, and which one is present is a
  // property of the composition rather than a choice here.
  //
  // - **The durable event.** Compaction commits `compaction/summary`, whose
  //   `summary` is the replacement text. This is what the Harness actually
  //   writes, and it is read here first.
  // - **A projected message.** A surface may instead fold that text into a
  //   `user/message` carrying a compaction source or a `<summary>` wrapper.
  //
  // Only one of the two is counted, and the durable event wins, because they
  // carry the same characters: counting both would report the summarized
  // conversation at twice its size, which is worse than reporting it at zero.
  // The marker-based path stays because it is the only one available to a
  // composition that does not write the durable event at all.
  const durableSummary = durableSummaryText(events)
  for (const event of events) {
    const type = typeof event.type === 'string' ? event.type : ''
    const data = (typeof event.data === 'object' && event.data !== null ? event.data : {}) as Record<string, unknown>
    if (type === 'user/message' || type === 'assistant/message') {
      const message = (data.message ?? data) as { readonly content?: unknown } | undefined
      const text = messageText(message?.content)
      if (text === '') continue
      const { blocks, remainder } = segmentPromptText(text)
      for (const [id, values] of Object.entries(blocks)) {
        for (const value of values ?? []) push(id as PromptCompositionCategoryId, value)
      }
      // A summary message is the summarized conversation, not new conversation.
      if (durableSummary === undefined && isSummaryEvent(data)) push('summary', remainder)
      else push('conversation', remainder)
      continue
    }
    if (type === 'tool/call') {
      push('conversation', `${String(data.name ?? 'tool')} ${String(data.arguments ?? '')}`)
      continue
    }
    if (type === 'tool/result') {
      const message = data.message as { readonly content?: unknown } | undefined
      const text = messageText(message?.content)
      if (text !== '') push('conversation', text)
    }
  }
  if (durableSummary !== undefined) push('summary', durableSummary)
  return sources
}

/**
 * The replacement text compaction committed, when the log carries one.
 *
 * Empty blocks contribute nothing, so the caller's `push` drops the whole entry
 * and the `summary` category stays genuinely absent rather than an empty string
 * counted as a zero-length row.
 */
function durableSummaryText(events: readonly PromptEventLike[]): string | undefined {
  let text: string | undefined
  for (const event of events) {
    if (typeof event.type !== 'string' || event.type !== 'compaction/summary') continue
    const data = (typeof event.data === 'object' && event.data !== null ? event.data : {}) as Record<string, unknown>
    const summary = messageText(data.summary)
    // The latest compaction wins: an earlier summary has already been folded into
    // the later one, so adding them would count the same history twice.
    if (summary !== '') text = summary
  }
  return text
}

/** One tool-call event, keyed by the id that pairs it with its result. */
export interface CollectedToolCall { readonly callId: string; readonly name: string; readonly arguments: string }

/**
 * Collect the transcript's items in order, pairing calls with their results.
 *
 * Calls and results are separate events in the log and separate entries here; the
 * tree is what joins them. Keeping them separate at this layer means an
 * unanswered call survives collection as a call with no result — the shape the
 * tree needs to show.
 *
 * @param events - the session's events, oldest first.
 * @param limit - the most items to return, newest kept when the log is longer.
 * @returns the items, plus how many the limit left out.
 */
export function collectPromptUsageItems(events: readonly PromptEventLike[], limit = 200): { readonly items: readonly PromptUsageItem[]; readonly omitted: number } {
  const items: PromptUsageItem[] = []
  for (const event of events) {
    const type = typeof event.type === 'string' ? event.type : ''
    const data = (typeof event.data === 'object' && event.data !== null ? event.data : {}) as Record<string, unknown>
    const seq = typeof event.seq === 'number' ? `#${String(event.seq)}` : ''
    if (type === 'user/message' || type === 'assistant/message') {
      const message = (data.message ?? data) as { readonly content?: unknown } | undefined
      const text = messageText(message?.content)
      if (text === '') continue
      const summary = isSummaryEvent(data)
      items.push({
        id: `message:${seq || String(items.length)}`,
        label: summary ? 'Summary' : type === 'user/message' ? 'User message' : 'Agent message',
        categoryId: summary ? 'summary' : 'conversation',
        text,
      })
      continue
    }
    if (type === 'tool/call') {
      const callId = String(data.callId ?? '')
      if (callId === '') continue
      items.push({
        id: `call:${callId}`,
        label: String(data.name ?? 'tool'),
        categoryId: 'conversation',
        text: String(data.arguments ?? ''),
        callId,
        role: 'call',
      })
      continue
    }
    if (type === 'tool/result') {
      const message = data.message as { readonly source?: { readonly callId?: unknown }; readonly content?: unknown } | undefined
      const callId = String(message?.source?.callId ?? '')
      const text = messageText(message?.content)
      if (callId === '' || text === '') continue
      items.push({
        id: `result:${callId}`,
        label: 'Result',
        categoryId: 'conversation',
        text,
        callId,
        role: 'result',
      })
    }
  }
  if (items.length <= limit) return { items, omitted: 0 }
  // Keep the newest: a breakdown of a long conversation is read for what just
  // entered the prompt, and the tail is where that is.
  return { items: items.slice(items.length - limit), omitted: items.length - limit }
}
