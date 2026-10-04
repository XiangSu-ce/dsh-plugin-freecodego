/**
 * Prompt-cache breakpoints for the Anthropic Messages wire.
 *
 * Why
 * ---
 * Anthropic caches a prefix only where the request marks one. A Messages body
 * with no `cache_control` block re-bills the whole conversation at the full
 * input rate on every turn, however much of it repeats — and it reads back
 * `cache_read_input_tokens: 0`, which is the symptom that produced this module:
 * a FreeCodeGo Claude group reported 1.3 M input tokens and a 0% hit rate,
 * because the client that sent the request never marked anything. Every
 * first-party Anthropic client marks breakpoints (Claude Code marks the end of
 * the tool block, the end of the system prompt, and the tail of the
 * conversation); a client that marks none leaves the upstream's cache unused.
 *
 * The gateway does not rescue that. Its own rewrite
 * (`rewrite_message_cache_control`) runs only on the OAuth mimicry path, so an
 * API-key group is forwarded byte for byte — whatever this wire sends is what
 * the upstream caches on. Marking here is therefore the only place the
 * Anthropic-protocol routes can get a hit at all.
 *
 * Where the marks go
 * ------------------
 * A breakpoint caches everything up to and including its block, so the marks
 * belong at the end of the segments that are stable across turns:
 *
 * 1. the last tool definition — the rendered tool list precedes the transcript;
 * 2. the system prompt — joined to one text block so it can carry a mark;
 * 3. the last user turn, and, once the transcript is long enough to be worth a
 *    second segment, the user turn before it.
 *
 * That is the gateway's own policy (`addMessageCacheBreakpoints` +
 * `applyToolsLastCacheBreakpoint`) and the ceiling Anthropic enforces: four
 * breakpoints per request. The system field is sent as a block array rather
 * than the bare string because only an array element can carry `cache_control`;
 * Anthropic accepts both shapes.
 *
 * The breakpoint is the default five-minute ephemeral window. A `ttl` is
 * deliberately not sent: the `1h` window needs the `extended-cache-ttl-2025-04-11`
 * beta on the request, and this transport sends no `anthropic-beta` header, so
 * naming a ttl would buy a rejection rather than a longer cache.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/anthropic-cache
 */

import { isRecord } from './untrusted-json.ts'

/** Anthropic accepts at most four `cache_control` breakpoints in one request. */
export const MAX_ANTHROPIC_CACHE_BREAKPOINTS = 4

/**
 * The one breakpoint kind this wire sends.
 *
 * Copied per site rather than shared: the body is serialized to JSON, and one
 * shared object handed to four positions would serialize fine but mutate as one
 * unit under any later in-place edit.
 */
const EPHEMERAL: Readonly<Record<string, unknown>> = { type: 'ephemeral' }

/**
 * Mark one content block, unless it already carries a breakpoint.
 * @param block - the block to mark.
 * @returns whether a mark was written.
 */
function markBlock(block: unknown): boolean {
  if (!isRecord(block) || block.cache_control !== undefined) return false
  block.cache_control = { ...EPHEMERAL }
  return true
}

/**
 * Mark the last content block of one conversation turn.
 * @param turn - the turn whose tail to mark.
 * @returns whether a mark was written.
 */
function markTurnTail(turn: unknown): boolean {
  if (!isRecord(turn)) return false
  const content = turn.content
  if (!Array.isArray(content) || content.length === 0) return false
  return markBlock(content[content.length - 1])
}

/**
 * Write the cache breakpoints onto an assembled Messages body.
 *
 * The body is edited in place — its `messages` and `tools` are the freshly
 * built request objects, and its `system` string is replaced by the block array
 * that can hold the mark — and returned for the caller to render.
 *
 * The size of a request is not consulted. Anthropic ignores a breakpoint whose
 * segment is below the model's minimum cacheable prefix (1 024 tokens for
 * Sonnet and Opus, 2 048 for Haiku) rather than rejecting it, so a short turn
 * costs nothing for carrying one, and a rule here would have to guess the
 * model's threshold to decide.
 * @param body - the serialized request.
 * @returns the same body, marked.
 */
export function applyAnthropicCacheBreakpoints(body: Record<string, unknown>): Record<string, unknown> {
  let remaining = MAX_ANTHROPIC_CACHE_BREAKPOINTS

  const tools = body.tools
  if (remaining > 0 && Array.isArray(tools) && tools.length > 0 && markBlock(tools[tools.length - 1])) remaining--

  if (remaining > 0 && typeof body.system === 'string' && body.system !== '') {
    body.system = [{ type: 'text', text: body.system, cache_control: { ...EPHEMERAL } }]
    remaining--
  }

  const messages = body.messages
  if (remaining > 0 && Array.isArray(messages) && messages.length > 0) {
    // Walk back over the transcript once. The first user turn found is the tail
    // of the conversation; the second is the far end of the window, marked only
    // once more than a single exchange is being resent.
    let userTurns = 0
    for (let index = messages.length - 1; index >= 0 && remaining > 0; index--) {
      const turn = messages[index]
      if (!isRecord(turn) || turn.role !== 'user') continue
      userTurns++
      if (userTurns === 1) {
        if (markTurnTail(turn)) remaining--
        continue
      }
      if (messages.length >= 4 && markTurnTail(turn)) remaining--
      break
    }
  }

  return body
}
