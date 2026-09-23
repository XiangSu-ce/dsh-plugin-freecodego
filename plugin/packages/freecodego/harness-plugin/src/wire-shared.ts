/**
 * SSE framing and block assembly shared by both wire dialects.
 *
 * `openai-wire.ts` and `anthropic-wire.ts` differ in how they *read* a stream,
 * not in what they build from it. Both assemble text, reasoning, and tool-call
 * blocks in stream order; both need a stable id when the provider omits a call
 * id; both close a stream with the same chunk sequence — every open block, then
 * usage, then the terminal reason; and both treat a stream that produced no
 * block as a failure rather than an empty success. Those facts were written
 * twice and had to agree byte for byte, or the same answer would arrive as
 * different `ContentBlock`s depending on which dialect happened to carry it.
 *
 * `parseSse` lives here for the same reason: it is the framing both dialects
 * read through (`translate` and `translateAnthropic` are both fed from it), and
 * leaving it in the OpenAI file made the Anthropic path import the other
 * dialect's module to get it.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/wire-shared
 */

import { EMPTY_RESPONSE_CODE, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { EventSourceParserStream } from 'eventsource-parser/stream'
import { redactCredentialShapes } from './secret-scan.ts'

/** The frame both dialects end their stream with. */
export const DONE = '[DONE]'

/**
 * Refuse a message this wire has no frame for.
 *
 * `developer` messages exist in the durable log but have no provider slot: the
 * core's own adapters both refuse them (`llm-deepseek` returns
 * `unsupported('developer message')` with the reason "provider serialization is
 * intentionally deferred"; `llm-pi-ai` throws `UNSUPPORTED_CONTENT`), so a wire
 * here must not invent one. Folding it into the user turn would be worse than
 * refusing: the tool-change blocks a developer message carries have no text of
 * their own, so the frame would arrive empty and the model would never learn
 * that its tool set changed — a silent failure, which is the one outcome this
 * package's callers cannot diagnose.
 *
 * @param what - the message or content with no frame on this dialect.
 * @throws LlmError marked `UNSUPPORTED_CONTENT`, the code the core classifies.
 */
export function unsupported(what: string): never {
  throw new LlmError(`${what} cannot be serialized on this wire`, 'UNSUPPORTED_CONTENT')
}

/** Read one SSE stream into its payloads, stopping at {@link DONE}.
 * @param stream - the response body to frame.
 * @returns the data payload of each event, in arrival order.
 */
export async function* parseSse(stream: ReadableStream<BufferSource>): AsyncGenerator<string> {
  const events = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream())
  for await (const event of events) {
    yield event.data
    if (event.data === DONE) return
  }
  // translate() tolerates a missing [DONE] when content was produced; an
  // empty payload stream falls through to it as well and surfaces there.
}

/** One provider block being assembled from deltas, in the order deltas opened it. */
export interface OpenBlock {
  readonly index: number
  readonly kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId?: string
  name?: string
}

/**
 * The call id a block carries: the provider's own, or one synthesized from the
 * block index when the provider sent none.
 *
 * Synthesized ids are stable per stream and never empty, because a tool result
 * is correlated back to its call by this string. Branded through the package's
 * own constructor rather than a cast: `ToolCallBlock.id` is a `ToolCallId`, so
 * the brand is the real contract here.
 * @param block - the block whose call id to resolve.
 * @returns the tool Call Id.
 */
export function callIdFor(block: OpenBlock): ToolCallId {
  return ToolCallId(block.callId ?? `call_${block.index}`)
}

/** Start a block and record it in the stream's order.
 * @param order - the stream's open-block list to append to.
 * @param index - the block's index within the stream.
 * @param kind - the block kind being assembled.
 * @returns the open Block.
 */
export function openBlock(order: OpenBlock[], index: number, kind: OpenBlock['kind']): OpenBlock {
  const block: OpenBlock = { index, kind, text: '' }
  order.push(block)
  return block
}

/** The block a stream has finished assembling.
 * @param block - the assembled block to close.
 * @returns the content Block.
 */
export function closeBlock(block: OpenBlock): ContentBlock {
  if (block.kind === 'text') return { type: 'text', text: block.text }
  if (block.kind === 'reasoning') return { type: 'reasoning', text: block.text }
  // The empty fallback is unreachable through `closeStream`, which refuses an
  // unnamed call before it closes one ({@link closeStream}); it stays because a
  // direct caller must still get a `ContentBlock` rather than a thrown error.
  return { type: 'tool-call', id: callIdFor(block), name: block.name ?? '', arguments: block.text }
}

/**
 * The terminal reason of a stream that produced no block.
 *
 * A provider that streams nothing and then stops has not answered: reporting
 * `stop` made the loop record an empty successful turn and left the caller
 * without a reason to retry.
 * @param blockCount - the number of blocks the stream produced.
 * @returns the finish Reason.
 */
export function emptyStreamFinish(blockCount: number): FinishReason {
  return blockCount === 0
    ? { kind: 'error', failure: { message: 'model returned no content', code: EMPTY_RESPONSE_CODE } }
    : { kind: 'stop' }
}

/** Arguments excerpt an unnamed tool call is reported with. */
const UNNAMED_TOOL_CALL_EXCERPT = 120

/**
 * Refuse to close a tool-call block the provider never named.
 *
 * `ToolCallBlock.name` is a string, so a call whose deltas never carried
 * `function.name` closed as the empty one — and that call reached the runtime as
 * `unknown tool ""`. A provider fault then arrived wearing this layer's shape: the
 * loop retried it, the transcript showed a tool call the model never made, and
 * nothing anywhere said the call was unusable. Naming the omission here, with the
 * call id and a masked excerpt of the arguments, turns a silent distortion into a
 * failure someone can act on. Anthropic's `tool_use` names the block that opens it
 * and OpenAI-compatible deltas carry the name whole, so a call still unnamed at
 * close is one no tool could ever be dispatched for.
 * @param order - the stream's open blocks, in assembly order.
 */
function assertToolCallsAreNamed(order: readonly OpenBlock[]): void {
  for (const block of order) {
    if (block.kind !== 'tool-call' || (block.name !== undefined && block.name !== '')) continue
    const arguments_ = redactCredentialShapes(block.text.slice(0, UNNAMED_TOOL_CALL_EXCERPT))
    throw new LlmError(
      `the provider sent a tool call with no function name (id ${String(callIdFor(block))}, arguments ${arguments_ === '' ? '(none)' : arguments_})`,
      'MALFORMED_RESPONSE',
    )
  }
}

/** Close every open block, then report usage and the terminal reason.
 * @param order - the stream's open blocks, in assembly order.
 * @param usage - the provider's token usage, when it reported any.
 * @param pendingFinish - the provider's terminal reason, when it sent one.
 * @returns the closing chunk sequence.
 */
export function* closeStream(
  order: readonly OpenBlock[],
  usage: TokenUsage | undefined,
  pendingFinish: FinishReason | undefined,
): Generator<StreamChunk> {
  assertToolCallsAreNamed(order)
  for (const block of order) yield { type: 'block-end', index: block.index, block: closeBlock(block) }
  if (usage !== undefined) yield { type: 'usage', usage }
  yield { type: 'finish', reason: pendingFinish ?? emptyStreamFinish(order.length) }
}
