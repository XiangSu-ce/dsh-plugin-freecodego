/**
 * Anthropic Messages request serialization and SSE translation owned by
 * FreeCodeGo.
 *
 * Mirrors `openai-wire.ts` for the gateway's `/v1/messages` route so a model
 * whose backend group speaks the Anthropic protocol is not silently sent an
 * OpenAI chat-completions body.
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, RequestMessage, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { callIdFor, closeStream, openBlock, DONE, unsupported } from './wire-shared.ts'
import type { OpenBlock } from './wire-shared.ts'
import { redactCredentialShapes } from './secret-scan.ts'
/** Anthropic requires `max_tokens`; this is the budget used when the caller has none. */
const DEFAULT_MAX_TOKENS = 8_192
/** Room a thinking budget needs beside itself inside `max_tokens`. */
const THINKING_ROOM = 1_024
const ANTHROPIC_VERSION = '2023-06-01'

/** Request headers required by the Anthropic Messages wire. */
export const ANTHROPIC_MESSAGES_HEADERS: Readonly<Record<string, string>> = { 'anthropic-version': ANTHROPIC_VERSION }

/** Resolves a durable image into an inline Anthropic request payload. */
export interface AnthropicInlineImageSerialization {
  readonly resolveImage: (ref: ImageAttachmentRef) => Promise<RequestImageAttachment>
}

type AnthropicBlock = Record<string, unknown>
interface AnthropicTurn { readonly role: 'user' | 'assistant'; readonly content: AnthropicBlock[] }

function blockText(block: ContentBlock): string {
  if (block.type === 'text') return block.text
  if (block.type === 'image') return `[image attachment: ${block.attachment.attachmentId}]`
  return ''
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.map(blockText).join('')
}

/**
 * Announces a replayed `tool_use` whose arguments could not be projected.
 *
 * An empty `input` is indistinguishable from a deliberate no-argument call, so
 * dropping the arguments in silence let the model re-issue the tool with
 * invented parameters while nobody downstream learned anything was lost. The
 * raw text is redacted before it is quoted, for the same reason this layer
 * redacts the upstream text it puts into an `LlmError`: a malformed arguments
 * blob can still contain a credential.
 */
function reportUnusableArguments(block: Extract<ContentBlock, { type: 'tool-call' }>, reason: string): void {
  console.warn(`[freecodego] tool_use ${block.name} (${block.id}) replayed with empty input: ${reason}; arguments=${redactCredentialShapes(block.arguments.slice(0, 120))}`)
}

function anthropicToolUse(block: Extract<ContentBlock, { type: 'tool-call' }>): AnthropicBlock {
  let input: unknown = {}
  if (block.arguments.trim() !== '') {
    try {
      input = JSON.parse(block.arguments)
    } catch {
      // A malformed arguments string must not fail the whole turn, and
      // Anthropic rejects a non-JSON `input`, so the call is still replayed
      // with an empty object. Only the silence was the bug: throwing here
      // would let one bad historical frame kill the whole turn, and reporting
      // the loss through the request body is impossible because `input` has to
      // stay an object for the wire. So keep the tolerance, announce the loss.
      reportUnusableArguments(block, 'arguments are not valid JSON')
      input = {}
    }
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    // Valid JSON that is not an object (an array, a scalar, `null`) is just as
    // unusable to Anthropic, and just as invisible to everyone if dropped
    // without a word, so it takes the same reported path as a parse failure.
    reportUnusableArguments(block, 'arguments are not a JSON object')
    input = {}
  }
  return { type: 'tool_use', id: block.id, name: block.name, input }
}

async function anthropicContent(message: RequestMessage, images?: AnthropicInlineImageSerialization): Promise<AnthropicBlock[]> {
  const blocks: AnthropicBlock[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        if (block.text !== '') blocks.push({ type: 'text', text: block.text })
        break
      case 'image': {
        if (images === undefined) {
          blocks.push({ type: 'text', text: blockText(block) })
          break
        }
        const image = await images.resolveImage(block.attachment)
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: image.mediaType, data: Buffer.from(image.data).toString('base64') },
        })
        break
      }
      case 'tool-call':
        // Historical reasoning signatures cannot be reconstructed, so only
        // tool_use and text survive an assistant replay.
        if (message.role === 'assistant') blocks.push(anthropicToolUse(block))
        break
      default:
        // `reasoning`, `file`, and merge-extended blocks have no Anthropic
        // representation here; dropping them keeps the request valid.
        break
    }
  }
  return blocks
}

async function anthropicTurns(
  options: GenerateOptions,
  images?: AnthropicInlineImageSerialization,
): Promise<{ readonly system: string | undefined; readonly messages: readonly AnthropicTurn[] }> {
  const systems: string[] = []
  if (options.system !== undefined && options.system !== '') systems.push(options.system)
  const messages: AnthropicTurn[] = []
  // Results of one assistant `tool_calls` batch belong in ONE user turn: that is
  // the shape Anthropic documents, and it is the shape the log used to carry,
  // when every result rode inside a single user message as a `tool-result`
  // block. A result is its own message now, so the batch is gathered here
  // instead. `flushResults` is called before any other turn and at the end, so
  // the frame lands immediately after the assistant turn that asked for it.
  const results: AnthropicBlock[] = []
  const flushResults = (): void => {
    if (results.length === 0) return
    messages.push({ role: 'user', content: results.splice(0) })
  }
  for (const message of options.messages) {
    if (message.role === 'system') {
      const text = textOf(message.content)
      if (text !== '') systems.push(text)
      continue
    }
    if (message.role === 'developer') unsupported('developer message')
    if (message.role === 'tool') {
      results.push({ type: 'tool_result', tool_use_id: message.toolCallId, content: textOf(message.content) || '(no output)' })
      continue
    }
    const content = await anthropicContent(message, images)
    // Anthropic rejects an empty content array, so a turn that projected to
    // nothing is dropped rather than sent as an invalid request.
    if (content.length === 0) continue
    flushResults()
    messages.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content })
  }
  flushResults()
  return { system: systems.length === 0 ? undefined : systems.join('\n\n'), messages }
}

function thinkingBudget(effort: string | undefined): number | undefined {
  switch (effort) {
    case 'low': return 1_024
    case 'medium': return 4_096
    case 'high': return 8_192
    case 'xhigh':
    case 'max': return 16_384
    default: return undefined
  }
}

function anthropicRequest(
  options: GenerateOptions,
  system: string | undefined,
  messages: readonly AnthropicTurn[],
): Record<string, unknown> {
  const effort = options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort)
  const budget = thinkingBudget(effort)
  const requested = options.maxTokens === undefined ? undefined : Math.max(1, Math.floor(options.maxTokens))
  // `budget_tokens` must stay strictly below `max_tokens`, with room left for the
  // answer. Raising an explicit caller cap to fit the thinking budget instead of
  // the reverse turned a 100-token request into a 9,216-token one — silently
  // multiplying both the reply's length and its cost — so a thinking step that
  // does not fit is dropped and the requested cap is honoured unchanged.
  const thinkingWithRoom = budget === undefined ? undefined : budget + THINKING_ROOM
  const thinkingFits = thinkingWithRoom !== undefined && (requested === undefined || thinkingWithRoom <= requested)
  const maxTokens = thinkingFits && thinkingWithRoom !== undefined
    ? Math.max(requested ?? DEFAULT_MAX_TOKENS, thinkingWithRoom)
    : requested ?? DEFAULT_MAX_TOKENS
  const tools = options.tools?.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }))
  return {
    model: options.model,
    max_tokens: maxTokens,
    stream: true,
    ...(system === undefined ? {} : { system }),
    messages,
    ...(thinkingFits && budget !== undefined ? { thinking: { type: 'enabled', budget_tokens: budget } } : {}),
    ...(tools === undefined || tools.length === 0 ? {} : { tools }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.stop === undefined ? {} : { stop_sequences: options.stop }),
  }
}

/** Serialize an Anthropic Messages request for a text-only turn.
 * @param options - the request to serialize.
 * @returns the projected record the caller renders.
 */
export async function serializeAnthropicRequest(options: GenerateOptions): Promise<Record<string, unknown>> {
  const { system, messages } = await anthropicTurns(options, undefined)
  return anthropicRequest(options, system, messages)
}

/** Serialize an Anthropic Messages request with inline base64 image parts.
 * @param options - the request to serialize.
 * @param images - the resolver that turns image blocks into base64 parts.
 * @returns the projected record the caller renders.
 */
export async function serializeAnthropicRequestWithInlineImages(
  options: GenerateOptions,
  images: AnthropicInlineImageSerialization,
): Promise<Record<string, unknown>> {
  const { system, messages } = await anthropicTurns(options, images)
  return anthropicRequest(options, system, messages)
}

function anthropicFinishReason(value: unknown): FinishReason {
  if (value === 'max_tokens') return { kind: 'max-tokens' }
  if (value === 'tool_use') return { kind: 'tool-calls' }
  if (value === 'refusal') return { kind: 'error', failure: { message: 'provider refused the request', code: 'PROVIDER_REFUSAL' } }
  // `end_turn`, `stop_sequence`, and unknown terminal reasons are a completed turn.
  return { kind: 'stop' }
}

function anthropicUsage(value: unknown): Partial<TokenUsage> | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const usage = value as Record<string, unknown>
  const input = usage.input_tokens
  const output = usage.output_tokens
  if (typeof input !== 'number' && typeof output !== 'number') return undefined
  const cacheRead = usage.cache_read_input_tokens
  const cacheWrite = usage.cache_creation_input_tokens
  return {
    ...(typeof input === 'number' ? { inputTokens: input } : {}),
    ...(typeof output === 'number' ? { outputTokens: output } : {}),
    ...(typeof cacheRead === 'number' ? { cacheReadTokens: cacheRead } : {}),
    ...(typeof cacheWrite === 'number' ? { cacheWriteTokens: cacheWrite } : {}),
  }
}

/** Translate Anthropic Messages SSE payloads into Harness stream chunks.
 * @param payloads - the SSE data payloads, in arrival order.
 * @returns the assembled Harness stream chunks.
 */
export async function* translateAnthropic(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  const order: OpenBlock[] = []
  const byAnthropicIndex = new Map<number, OpenBlock>()
  let pendingFinish: FinishReason | undefined
  let usage: TokenUsage | undefined
  const open = (kind: OpenBlock['kind']): OpenBlock => openBlock(order, nextIndex++, kind)
  const mergeUsage = (next: Partial<TokenUsage> | undefined): void => {
    if (next === undefined) return
    const cacheReadTokens = next.cacheReadTokens ?? usage?.cacheReadTokens
    const cacheWriteTokens = next.cacheWriteTokens ?? usage?.cacheWriteTokens
    usage = {
      inputTokens: next.inputTokens ?? usage?.inputTokens ?? 0,
      outputTokens: next.outputTokens ?? usage?.outputTokens ?? 0,
      ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
      ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    }
  }
  // Shared with the OpenAI wire (see `wire-shared.ts`): a stream that produced
  // no block is a failure here too, never an empty successful turn.
  const terminal = (): Generator<StreamChunk> => closeStream(order, usage, pendingFinish)
  for await (const payload of payloads) {
    if (payload === DONE) {
      yield* terminal()
      return
    }
    let event: Record<string, unknown>
    // Masked for the same reason as in `openai-wire.ts`: this layer quotes the
    // upstream's own text into an `LlmError`, and it is shared by every
    // Anthropic-shaped provider, so no single adapter's redaction covers it.
    try { event = JSON.parse(payload) as Record<string, unknown> } catch { throw new LlmError(`malformed SSE payload: ${redactCredentialShapes(payload.slice(0, 120))}`, 'MALFORMED_RESPONSE') }
    const type = event.type
    if (type === 'error') {
      const error = event.error !== null && typeof event.error === 'object' ? event.error as Record<string, unknown> : {}
      const message = typeof error.message === 'string' && error.message.trim() !== '' ? error.message : 'provider returned an error'
      throw new LlmError(redactCredentialShapes(message), typeof error.type === 'string' ? error.type : 'PROVIDER_ERROR')
    }
    if (type === 'message_start') {
      const message = event.message !== null && typeof event.message === 'object' ? event.message as Record<string, unknown> : {}
      mergeUsage(anthropicUsage(message.usage))
      continue
    }
    if (type === 'content_block_start') {
      const index = typeof event.index === 'number' ? event.index : undefined
      const source = event.content_block !== null && typeof event.content_block === 'object' ? event.content_block as Record<string, unknown> : {}
      if (index === undefined) continue
      const kind = source.type === 'tool_use' ? 'tool-call' : source.type === 'thinking' ? 'reasoning' : source.type === 'text' ? 'text' : undefined
      // Unknown block kinds (`redacted_thinking`, server tool blocks) are
      // skipped; their deltas are then ignored because no block is recorded.
      if (kind === undefined) { byAnthropicIndex.delete(index); continue }
      const block = open(kind)
      if (kind === 'tool-call') {
        if (typeof source.id === 'string' && source.id !== '') block.callId = source.id
        if (typeof source.name === 'string' && source.name !== '') block.name = source.name
      }
      byAnthropicIndex.set(index, block)
      yield { type: 'block-start', index: block.index, blockType: kind }
      continue
    }
    if (type === 'content_block_delta') {
      const index = typeof event.index === 'number' ? event.index : undefined
      if (index === undefined) continue
      const delta = event.delta !== null && typeof event.delta === 'object' ? event.delta as Record<string, unknown> : {}
      let block = byAnthropicIndex.get(index)
      if (block === undefined) {
        // A delta whose `content_block_start` never arrived — a dropped frame,
        // or a provider that never sent one — used to be discarded: the text
        // vanished and the turn still looked complete. Text and thinking need no
        // metadata, so the block is opened from the delta's own type and the
        // content is delivered. Tool input is deliberately NOT recovered this
        // way: Anthropic streams server-side tools (`server_tool_use`) with the
        // same `input_json_delta` shape, and inventing a client tool call for one
        // would be worse than dropping it.
        const recovered = delta.type === 'text_delta' ? 'text' as const : delta.type === 'thinking_delta' ? 'reasoning' as const : undefined
        if (recovered === undefined) continue
        block = open(recovered)
        byAnthropicIndex.set(index, block)
        yield { type: 'block-start', index: block.index, blockType: recovered }
      }
      if (block.kind === 'tool-call') {
        const fragment = typeof delta.partial_json === 'string'
          ? delta.partial_json
          // A gateway that assembles the call instead of streaming fragments
          // sends `partial_json` as a JSON value rather than a string. Reading
          // only strings dropped the arguments and left the call with an empty
          // input, which is the same silent distortion the OpenAI wire had on
          // its own arguments field; re-serializing keeps the call intact and
          // still yields a string.
          : delta.partial_json === undefined || delta.partial_json === null ? '' : JSON.stringify(delta.partial_json)
        if (fragment === '') continue
        block.text += fragment
        yield { type: 'tool-call-delta', index: block.index, id: callIdFor(block), ...(block.name === undefined ? {} : { name: block.name }), argumentsDelta: fragment }
        continue
      }
      if (block.kind === 'reasoning') {
        const thinking = typeof delta.thinking === 'string' ? delta.thinking : ''
        if (thinking === '') continue
        block.text += thinking
        yield { type: 'reasoning-delta', index: block.index, text: thinking }
        continue
      }
      const fragment = typeof delta.text === 'string' ? delta.text : ''
      if (fragment === '') continue
      block.text += fragment
      yield { type: 'text-delta', index: block.index, text: fragment }
      continue
    }
    if (type === 'message_delta') {
      const delta = event.delta !== null && typeof event.delta === 'object' ? event.delta as Record<string, unknown> : {}
      const stopReason = delta.stop_reason
      if (typeof stopReason === 'string') pendingFinish = anthropicFinishReason(stopReason)
      mergeUsage(anthropicUsage(event.usage))
      continue
    }
    if (type === 'message_stop') {
      yield* terminal()
      return
    }
    // `content_block_stop`, `ping`, and unknown events carry no stream data.
  }
  if (order.length === 0 && usage === undefined) throw new LlmError('SSE payload stream ended without a message_stop event', 'STREAM_CLOSED')
  // `message_stop` is a formality after `message_delta` declared the stop
  // reason, and the two are tolerated apart. Both missing after content is not
  // that case: the connection died mid-answer, and the text so far is a
  // truncation that used to be reported as a completed turn.
  if (order.length > 0 && pendingFinish === undefined) throw new LlmError('SSE payload stream ended mid-answer without a message_stop event or a stop reason', 'STREAM_CLOSED')
  yield* terminal()
}
