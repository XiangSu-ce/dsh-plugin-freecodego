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
 * Every entry is either a tag this codebase actually renders or a tag a
 * neighbouring composition renders: `freecodego-skill-map` is this plugin's own
 * session-start catalog, and the `skill_*` / `available_skills` set is what
 * `@deepseek-ai/dsh-skill` wraps a loaded Skill in.
 *
 * Two entries name buckets **nothing in this Harness fills**, and they are kept
 * rather than deleted so the mapping stays a description of the shape instead of a
 * list of today's producers: `available_subagent_types` /
 * `available_subagent_models` would be an agent-type catalog, and a grep of this
 * checkout finds no such section, tag, or injection anywhere — the only
 * subagent-specific prompt text is one sentence inside a `tool:` section about
 * starting delegations in parallel, which is tool guidance. A zero row there is
 * the truth of this composition; a row fed by guessing would be worse.
 * `dynamic_tool_*` / `mcp_*` are in the same position for the *catalog* shape: MCP
 * presence in this Harness is tool schemas (the `tools` bucket, which they land in
 * by name) plus per-server instructions (a `mcp:` system-prompt section, see
 * {@link SYSTEM_SECTION_CATEGORIES}), so a separate `mcp_*` block is not something
 * this composition emits.
 *
 * `skill_content` is the outermost of that set — `renderSkillContent` wraps the
 * resource hint and the body in it — and listing it matters even though its two
 * inner tags are listed too: `outermost()` keeps the outer range, so the wrapper
 * is what moves the *whole* block (attributes, resource hint and body) as one
 * unit. Without it the two inner ranges still moved, but the wrapper tags stayed
 * behind in the conversation, and the row that is the residual is the one place
 * a stray 60-character fragment is invisible.
 */
const TAGGED_BLOCK_CATEGORIES: readonly { readonly tag: string | RegExp; readonly categoryId: PromptCompositionCategoryId }[] = [
  { tag: 'freecodego-skill-map', categoryId: 'skills' },
  { tag: 'available_skills', categoryId: 'skills' },
  { tag: 'skill_content', categoryId: 'skills' },
  { tag: 'skill_instructions', categoryId: 'skills' },
  { tag: 'skill_resources', categoryId: 'skills' },
  { tag: 'rules', categoryId: 'rules' },
  { tag: 'available_subagent_types', categoryId: 'subagents' },
  { tag: 'available_subagent_models', categoryId: 'subagents' },
  { tag: /^mcp_/u, categoryId: 'mcp' },
  { tag: /^dynamic_tool/u, categoryId: 'mcp' },
]

/**
 * Tags that frame a block without claiming it.
 *
 * A wrapper's bucket is a **default**, and a recognised bucket tag nested inside
 * it overrides that default, because the two producers of this wrapper in this
 * Harness disagree about what it means: `agent-instructions` bakes the whole
 * workspace-instruction baseline (AGENTS.md and friends) in one, which is the
 * `rules` bucket, while `tool-skill` wraps its `available_skills` catalog in one,
 * which is `skills`. Treating the wrapper as a bucket would file every Skill
 * catalog under Rules, and treating it as unknown would leave the instruction
 * baseline — often the largest block a project adds — in the conversation.
 */
const WRAPPER_TAGS: readonly { readonly tag: string; readonly categoryId: PromptCompositionCategoryId }[] = [
  { tag: 'system-reminder', categoryId: 'rules' },
]

const WRAPPER_BY_TAG = new Map(WRAPPER_TAGS.map(entry => [entry.tag, entry.categoryId]))

/**
 * System-prompt section names, mapped to the bucket they belong in.
 *
 * The rendered system prompt is its sections joined with blank lines and carries
 * **no markers**, so a section cannot be recognised from the text — the name is the
 * only classification that exists, and it is available one level up, on the
 * assembly (§{@link PromptSectionLike}). Deliberately prefix-driven and short:
 * the harness names each tool's usage guidance `tool:<name>`, each MCP server's
 * own instructions `mcp:<server>`, and the resource-server catalog
 * `mcp-resource-servers`; every other section (`deployment:persona-*`, `tool`-less
 * guidance, this plugin's own `freecodego: *`) is standing system text and stays in
 * `system-prompt` rather than being guessed at.
 */
const SYSTEM_SECTION_CATEGORIES: readonly { readonly pattern: RegExp; readonly categoryId: PromptCompositionCategoryId }[] = [
  { pattern: /^mcp:/u, categoryId: 'mcp' },
  { pattern: /^mcp-resource-servers$/u, categoryId: 'mcp' },
  { pattern: /^tool:/u, categoryId: 'tools' },
]

/** One rendered system-prompt section: the name it was registered under, and its text. */
export interface PromptSectionLike {
  readonly name: string
  readonly text: string
}

/**
 * Split the collected system prompt into the buckets its sections belong to.
 *
 * Matching on the section **text** rather than on an offset is what makes this
 * safe to run against a prompt that was assembled somewhere else: a section is only
 * ever attributed when its exact text is present in the text this session actually
 * carried, so a section that changed between the assembly and the request — or one
 * whose text is still an uninterpolated `{{variable}}` — simply is not found and
 * stays in `system-prompt`. Nothing is invented and nothing is moved twice, and the
 * case where no section matches is byte-for-byte the behaviour before sections were
 * read at all.
 *
 * @param text - the system prompt as collected off the session.
 * @param sections - the assembled sections, when the caller could read them.
 * @returns segments in text order; unmapped text is returned as `system-prompt`.
 */
export function segmentSystemPrompt(
  text: string,
  sections: readonly PromptSectionLike[] | undefined,
): readonly { readonly categoryId: PromptCompositionCategoryId; readonly text: string }[] {
  if (text === '') return []
  if (sections === undefined || sections.length === 0) return [{ categoryId: 'system-prompt', text }]
  const found: { start: number; end: number; categoryId: PromptCompositionCategoryId }[] = []
  for (const section of sections) {
    if (section.text === '') continue
    const categoryId = SYSTEM_SECTION_CATEGORIES.find(entry => entry.pattern.test(section.name))?.categoryId
    // An unmapped section is not located at all: its text belongs to
    // `system-prompt` wherever it sits, and locating it would only add a segment
    // that splits the surrounding text for no change in the answer.
    if (categoryId === undefined) continue
    let from = 0
    while (from <= text.length - section.text.length) {
      const at = text.indexOf(section.text, from)
      if (at === -1) break
      found.push({ start: at, end: at + section.text.length, categoryId })
      from = at + section.text.length
    }
  }
  if (found.length === 0) return [{ categoryId: 'system-prompt', text }]
  // Longest first at the same offset, then in order, and never overlapping: a
  // repeated section text (a tool's guidance rendered twice) yields two segments,
  // and two sections that share a prefix yield the longer one.
  const ordered = [...found].sort((left, right) => left.start - right.start || right.end - left.end)
  const segments: { categoryId: PromptCompositionCategoryId; text: string }[] = []
  let cursor = 0
  for (const match of ordered) {
    if (match.start < cursor) continue
    if (match.start > cursor) segments.push({ categoryId: 'system-prompt', text: text.slice(cursor, match.start) })
    segments.push({ categoryId: match.categoryId, text: text.slice(match.start, match.end) })
    cursor = match.end
  }
  if (cursor < text.length) segments.push({ categoryId: 'system-prompt', text: text.slice(cursor) })
  return segments
}

const categoryForTag = (tag: string): PromptCompositionCategoryId | undefined =>
  TAGGED_BLOCK_CATEGORIES.find(entry => typeof entry.tag === 'string' ? entry.tag === tag : entry.tag.test(tag))?.categoryId

const isKnownTag = (tag: string): boolean => categoryForTag(tag) !== undefined || WRAPPER_BY_TAG.has(tag)

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

/**
 * The bucket of the first recognised tag nested inside a wrapper's own range.
 *
 * The wrapper's text is not searched recursively for ranges: the question is only
 * which bucket the wrapper's *one* range belongs to, and the earliest recognised
 * opening tag answers it without a second traversal.
 * @param inner - the wrapper's complete text, tags included.
 * @returns the nested bucket, or `undefined` when the wrapper holds nothing recognised.
 */
function nestedCategory(inner: string): PromptCompositionCategoryId | undefined {
  let earliest: { at: number; categoryId: PromptCompositionCategoryId } | undefined
  for (const name of tagNames(inner)) {
    const categoryId = categoryForTag(name)
    if (categoryId === undefined) continue
    const at = inner.search(new RegExp(`<${name}(?:\\s[^>]*)?>`, 'u'))
    if (at === -1) continue
    if (earliest === undefined || at < earliest.at) earliest = { at, categoryId }
  }
  return earliest?.categoryId
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
    if (!isKnownTag(name)) continue
    found.push(...tagRanges(text, name))
  }
  const selected = outermost(found)
  const blocks: Partial<Record<PromptCompositionCategoryId, string[]>> = {}
  for (const range of selected) {
    const wrapperDefault = WRAPPER_BY_TAG.get(range.tag)
    const category = wrapperDefault === undefined
      ? categoryForTag(range.tag)
      : nestedCategory(text.slice(range.start, range.end)) ?? wrapperDefault
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
 * Exported because it is this package's one reader for that shape, and the second
 * caller is the reason to share it rather than write a narrower check: the
 * compaction-fidelity audit read `compaction/summary` as `typeof summary ===
 * 'string'`, while the Harness commits the replacement as **content blocks** (the
 * shape this function exists to join) — so the audit returned early on every real
 * event and the check had never run. A caller holding a summary has to read it the
 * way the surface that wrote it does.
 *
 * @param content - a message's content, or one nested block's.
 * @param depth - remaining recursion budget; internal.
 * @returns the concatenated text of every text-bearing part.
 */
export function messageText(content: unknown, depth = 4): string {
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

/**
 * Whether one event is the compaction summary carrier rather than a real turn.
 *
 * The summary is written by the core's compaction, and the source kind it stamps is
 * `compact-checkpoint` — the name that subsystem declares. This used to look for a
 * `compaction` kind, which nothing ever wrote, so the first branch was dead and only
 * the text markers below could recognise a summary. A summary the markers miss is
 * counted as a real turn, which inflates the turn bucket of the breakdown.
 */
function isSummaryEvent(data: Record<string, unknown>): boolean {
  const message = data.message as { readonly source?: { readonly kind?: unknown } } | undefined
  if (message?.source?.kind === 'compact-checkpoint') return true
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
export function collectPromptCompositionSources(
  header: PromptHeaderLike | undefined,
  events: readonly PromptEventLike[],
  options: { readonly systemSections?: readonly PromptSectionLike[] | undefined } = {},
): PromptCompositionSources {
  const sources: Partial<Record<PromptCompositionCategoryId, string[]>> = {}
  const push = (id: PromptCompositionCategoryId, text: string): void => {
    if (text === '') return
    ;(sources[id] ??= []).push(text)
  }

  // The system prompt is a *session event* in this Harness, not a header field:
  // `EpochHeader.system` is `never` (`core/session`), and `agent-loop` renders the
  // assembly and commits it as `system/message` events. Reading only the header
  // meant the system prompt — the largest fixed block a request carries, and the
  // carrier of every MCP server's own instructions — was counted in no row at all,
  // and because the conversation row is the residual its tokens were silently
  // *added* to the transcript. The header path is kept for a composition that
  // still stamps it.
  const systemText = systemPromptText(header, events)
  for (const segment of segmentSystemPrompt(systemText, options.systemSections)) push(segment.categoryId, segment.text)
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
      if (text === '') continue
      // A tool result is segmented exactly like a message, because the largest
      // tagged block a session ever receives arrives this way: the `skill`
      // tool's result *is* the rendered Skill, so a result read as plain
      // conversation put every loaded Skill body in the residual row and left
      // the Skills row holding only the catalogs. The bucket a block belongs to
      // is a property of the text, not of the event that carried it.
      const { blocks, remainder } = segmentPromptText(text)
      for (const [id, values] of Object.entries(blocks)) {
        for (const value of values ?? []) push(id as PromptCompositionCategoryId, value)
      }
      push('conversation', remainder)
    }
  }
  if (durableSummary !== undefined) push('summary', durableSummary)
  return sources
}

/**
 * The system prompt this session carries, as the log recorded it.
 *
 * Every non-empty `system/message` contributes, in event order, because that is
 * what the projection itself means: a route that cannot keep the prompt in history
 * has the head node rewritten with the full rendered text and its later nodes
 * emptied, while a route that can appends the changed text after the cached
 * prefix — and the request carries both. Joining the non-empty nodes is exactly
 * the set of characters either shape sends, and an emptied node contributes
 * nothing precisely because it was removed.
 *
 * The header's own `system` is prepended when a composition stamps one, so this
 * keeps working for the shape the collector originally read.
 */
function systemPromptText(header: PromptHeaderLike | undefined, events: readonly PromptEventLike[]): string {
  const parts: string[] = []
  if (typeof header?.system === 'string' && header.system !== '') parts.push(header.system)
  for (const event of events) {
    if (event.type !== 'system/message') continue
    const data = (typeof event.data === 'object' && event.data !== null ? event.data : {}) as Record<string, unknown>
    const message = (data.message ?? data) as { readonly content?: unknown } | undefined
    const text = messageText(message?.content)
    if (text !== '') parts.push(text)
  }
  return parts.join('\n\n')
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

/**
 * The bucket an item belongs to when the item *is* one tagged block.
 *
 * The tree gives every node exactly one category, so an item that mixes a block
 * with conversation cannot be split across two category nodes without being
 * counted twice. The rule is therefore the narrow one: text that is *only* a
 * recognised block belongs to that block's bucket, and anything with text left
 * over stays conversation. Applied to a tool result and not to a message, and
 * deliberately so: a tool result carrying a Skill *is* the Skill (that is the
 * whole payload the `skill` tool returns), while a message item is a turn whose
 * label the reader navigates by — the breakdown apportions that turn's blocks
 * to their own rows, and the tree keeps the turn intact.
 *
 * @param text - one item's collected text.
 * @returns the block's category, or `undefined` for mixed or untagged text.
 */
function blockOnlyCategory(text: string): PromptCompositionCategoryId | undefined {
  const { blocks, remainder } = segmentPromptText(text)
  if (remainder.trim() !== '') return undefined
  const ids = Object.keys(blocks) as PromptCompositionCategoryId[]
  return ids.length === 1 ? ids[0] : undefined
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
        // A result that is entirely a tagged block shows up under that block's
        // category node, so the tree and the breakdown agree about where a
        // loaded Skill's bytes are. A result that mixes blocks with output
        // stays conversation, for the one-category-per-node reason above.
        categoryId: blockOnlyCategory(text) ?? 'conversation',
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
