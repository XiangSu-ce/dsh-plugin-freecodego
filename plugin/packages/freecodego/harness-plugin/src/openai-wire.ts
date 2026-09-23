/** OpenAI-compatible request serialization and SSE translation owned by FreeCodeGo. */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, Message, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { callIdFor, closeStream, openBlock, DONE, unsupported } from './wire-shared.ts'
import type { OpenBlock } from './wire-shared.ts'
import { redactCredentialShapes } from './secret-scan.ts'

type WireMessage = Record<string, unknown>

/** Resolves a durable image into an inline OpenAI-compatible request payload. */
export interface InlineImageSerialization {
  readonly resolveImage: (ref: ImageAttachmentRef) => Promise<RequestImageAttachment>
}

function text(blocks: readonly ContentBlock[]): string {
  return blocks.map((block) => {
    if (block.type === 'text') return block.text
    if (block.type === 'image') return `[image attachment: ${block.attachment.attachmentId}]`
    return ''
  }).join('')
}

function assertTextOnly(blocks: readonly ContentBlock[]): void {
  // Historical generated images can be nested in tool results. They are
  // represented by `text()` as attachment placeholders instead of blocking a
  // later text-only turn with UNSUPPORTED_CONTENT.
  void blocks
}

function serializeAssistant(message: Message): WireMessage {
  const calls = message.content
    .filter((block): block is Extract<ContentBlock, { type: 'tool-call' }> => block.type === 'tool-call')
    .map(block => ({ id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } }))
  const reasoning = message.content
    .filter((block): block is Extract<ContentBlock, { type: 'reasoning' }> => block.type === 'reasoning')
    .map(block => block.text).join('')
  return {
    role: 'assistant', content: text(message.content),
    ...(calls.length === 0 ? {} : { tool_calls: calls }),
    ...(calls.length === 0 || reasoning === '' ? {} : { reasoning_content: reasoning }),
  }
}

/** Serialize only the OpenAI-compatible subset required by FreeCodeGo routes. */
/**
 * Does this request carry a directly uploaded image?
 *
 * Images nested in historical tool results are rendered as text by this
 * serializer, so only direct user uploads need inline resolution. Every route
 * that chooses between `serializeRequest` and `serializeRequestWithInlineImages`
 * asks this same question, and the answer belongs with the serializer that
 * defines it: the Agnes route and the OpenAI-compatible adapter each used to
 * carry their own copy of the predicate.
 *
 * @param options - the request about to be serialized.
 * @returns `true` when at least one direct user image block is present.
 */
export function hasImageContent(options: GenerateOptions): boolean {
  return options.messages.some(message => message.role === 'user' && message.content.some(block => block.type === 'image'))
}

/** Serialize a chat-completions request body from the Harness's options.
 * @param options - the request to serialize.
 * @param defaults - the wire and usage defaults for this route.
 * @returns the request body the provider receives.
 */
export function serializeRequest(options: GenerateOptions, defaults: { readonly reasoningWire?: 'gateway' | 'standard'; readonly includeUsage?: boolean } = {}): Record<string, unknown> {
  const messages: WireMessage[] = []
  if (options.system !== undefined) messages.push({ role: 'system', content: options.system })
  for (const message of options.messages) {
    if (message.role === 'system') { assertTextOnly(message.content); messages.push({ role: 'system', content: text(message.content) }); continue }
    if (message.role === 'assistant') { messages.push(serializeAssistant(message)); continue }
    // A tool result is its own message now, naming the call it answers. It used
    // to ride inside a user message as a `tool-result` content block, which is
    // why this loop once filtered those blocks out and folded whatever text
    // surrounded them into a trailing user turn. The ordering that made that
    // necessary is already the log's own order: the assistant `tool_calls`
    // frame, then one tool frame per result.
    if (message.role === 'tool') { messages.push({ role: 'tool', tool_call_id: message.toolCallId, content: text(message.content) || '(no output)' }); continue }
    if (message.role === 'developer') unsupported('developer message')
    assertTextOnly(message.content)
    messages.push({ role: 'user', content: text(message.content) })
  }
  return requestWithMessages(options, messages, defaults)
}

/** Serialize an OpenAI-compatible request with inline data-URL image parts.
 * @param options - the request to serialize.
 * @param images - the resolver that turns image blocks into data URLs.
 * @param defaults - the wire and usage defaults for this route.
 * @returns the projected record the caller renders.
 */
export async function serializeRequestWithInlineImages(
  options: GenerateOptions,
  images: InlineImageSerialization,
  defaults: { readonly reasoningWire?: 'gateway' | 'standard'; readonly includeUsage?: boolean } = {},
): Promise<Record<string, unknown>> {
  const messages: WireMessage[] = []
  if (options.system !== undefined) messages.push({ role: 'system', content: options.system })
  for (const message of options.messages) {
    if (message.role === 'system') {
      assertTextOnly(message.content)
      messages.push({ role: 'system', content: text(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      assertTextOnly(message.content)
      messages.push(serializeAssistant(message))
      continue
    }
    // Keep tool frames adjacent to their assistant tool_calls here too; see
    // `serializeRequest` for why the filter this replaced is gone.
    if (message.role === 'tool') { messages.push({ role: 'tool', tool_call_id: message.toolCallId, content: text(message.content) || '(no output)' }); continue }
    if (message.role === 'developer') unsupported('developer message')
    const content = await inlineUserContent(message.content, images)
    messages.push({ role: 'user', content: inlineUserWireContent(content) })
  }
  return requestWithMessages(options, messages, defaults)
}

async function inlineUserContent(
  blocks: readonly ContentBlock[],
  images: InlineImageSerialization,
): Promise<Record<string, unknown>[]> {
  const content: Record<string, unknown>[] = []
  for (const block of blocks) {
    if (block.type === 'text' && block.text !== '') content.push({ type: 'text', text: block.text })
    if (block.type !== 'image') continue
    const image = await images.resolveImage(block.attachment)
    content.push({
      type: 'image_url',
      image_url: { url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}` },
    })
  }
  return content
}

function inlineUserWireContent(content: readonly Record<string, unknown>[]): string | readonly Record<string, unknown>[] {
  return content.every(part => part.type === 'text')
    ? content.map(part => String(part.text ?? '')).join('')
    : content
}

function requestWithMessages(
  options: GenerateOptions,
  messages: readonly WireMessage[],
  defaults: { readonly reasoningWire?: 'gateway' | 'standard'; readonly includeUsage?: boolean },
): Record<string, unknown> {
  const tools = options.tools?.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
  const effort = options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort)
  const reasoning = effort === undefined || effort === 'off'
    ? {}
    : defaults.reasoningWire === 'standard'
      ? { reasoning_effort: effort }
      : { thinking: { type: 'enabled' }, reasoning_effort: effort === 'xhigh' ? 'max' : effort }
  return {
    model: options.model, messages, stream: true,
    ...(defaults.includeUsage === false ? {} : { stream_options: { include_usage: true } }),
    ...reasoning,
    ...(tools === undefined || tools.length === 0 ? {} : { tools }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.stop === undefined ? {} : { stop: options.stop }),
  }
}

function finishReason(value: unknown): FinishReason {
  if (value === 'stop') return { kind: 'stop' }
  if (value === 'tool_calls' || value === 'function_call') return { kind: 'tool-calls' }
  if (value === 'length') return { kind: 'max-tokens' }
  // Refusals and content filters are terminal, not successful completions:
  // mapping them to `stop` made the loop treat a refusal as a finished turn
  // with no way to surface the provider's rejection to the user.
  if (value === 'refusal') return { kind: 'error', failure: { message: 'provider refused the request', code: 'PROVIDER_REFUSAL' } }
  if (value === 'content_filter') return { kind: 'error', failure: { message: 'provider content filter stopped the response', code: 'PROVIDER_CONTENT_FILTER' } }
  // Unknown terminal reasons are still a completed turn; treat them as stop.
  return { kind: 'stop' }
}

function usage(value: unknown): TokenUsage | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const input = (value as Record<string, unknown>).prompt_tokens
  const output = (value as Record<string, unknown>).completion_tokens
  if (typeof input !== 'number' || typeof output !== 'number') return undefined
  const details = (value as Record<string, unknown>).prompt_tokens_details
  const cached = details !== null && typeof details === 'object' ? (details as Record<string, unknown>).cached_tokens : undefined
  return { inputTokens: input - (typeof cached === 'number' ? cached : 0), outputTokens: output, ...(typeof cached === 'number' ? { cacheReadTokens: cached } : {}) }
}

/**
 * The text a delta — or a non-streaming `message` read through the fallback
 * below — carries.
 *
 * The OpenAI schema types content as a string, but the multimodal *part list*
 * (`[{type:'text',text:'…'}]`) is a legal body shape elsewhere in the same
 * family, and a gateway that answers with it had every part ignored: the reply
 * arrived as an empty turn with nothing anywhere to say why. Parts that are not
 * text (images, unknown objects) are still not text and are skipped, exactly as
 * they were.
 */
function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return undefined
  return value.map((part) => {
    if (typeof part === 'string') return part
    if (part === null || typeof part !== 'object') return ''
    const text = (part as Record<string, unknown>).text
    return typeof text === 'string' ? text : ''
  }).join('')
}

/** Translate standard OpenAI chat-completions SSE chunks into Harness stream chunks.
 * @param payloads - the SSE data payloads, in arrival order.
 * @returns the assembled Harness stream chunks.
 */
export async function* translate(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  const order: OpenBlock[] = []
  const tools = new Map<string, OpenBlock>()
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  let pendingUsage: TokenUsage | undefined
  let pendingFinish: FinishReason | undefined
  const open = (kind: OpenBlock['kind']): OpenBlock => openBlock(order, nextIndex++, kind)
  // Shared with the Anthropic wire (see `wire-shared.ts`): every open block,
  // then usage, then the terminal reason — a stream that produced no block is a
  // failure rather than an empty successful turn.
  const terminal = (): Generator<StreamChunk> => closeStream(order, pendingUsage, pendingFinish)
  for await (const payload of payloads) {
    if (payload === DONE) {
      yield* terminal()
      return
    }
    let parsed: unknown
    // Both messages below quote text the upstream sent us: the raw chunk it
    // failed to parse, and the error event it chose to send. Masked here because
    // this layer is shared by every OpenAI-compatible provider — an adapter's own
    // redaction never sees text that became an `LlmError` before it.
    try { parsed = JSON.parse(payload) } catch { throw new LlmError(`malformed SSE payload: ${redactCredentialShapes(payload.slice(0, 120))}`, 'MALFORMED_RESPONSE') }
    // A frame that parses but is not an object carries no stream data, and used
    // to be ignored field by field: a gateway whose envelope differs from
    // OpenAI's ended the answer with no trace of why. `null` did worse — reading
    // `.error` off it threw a TypeError the adapter reported as a transport
    // failure, which named the wrong layer.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new LlmError(`unexpected SSE payload shape: ${redactCredentialShapes(payload.slice(0, 120))}`, 'MALFORMED_RESPONSE')
    }
    const chunk = parsed as Record<string, unknown>
    const rawError = chunk.error
    const providerError = rawError !== null && typeof rawError === 'object'
      ? rawError as Record<string, unknown>
      // Providers do send `{"error": "..."}`: a string where the OpenAI shape
      // puts an object. Reading only objects dropped the reason, and because
      // such a frame carries no choices either, a failure that arrived
      // mid-answer was reported as a short completed turn instead.
      : typeof rawError === 'string' && rawError.trim() !== '' ? { message: rawError } : undefined
    if (providerError !== undefined) {
      const message = typeof providerError.message === 'string' && providerError.message.trim() !== '' ? providerError.message : 'provider returned an error'
      throw new LlmError(redactCredentialShapes(message), typeof providerError.code === 'string' ? providerError.code : 'PROVIDER_ERROR')
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : []
    for (const choice of choices) {
      if (choice === null || typeof choice !== 'object') continue
      const row = choice as Record<string, unknown>
      // A provider that ignored stream:true returns a full completion whose
      // payload sits in choices[].message with the same field names; read it
      // as one synthetic delta so the content is not silently discarded.
      const rawDelta = row.delta !== null && typeof row.delta === 'object' ? row.delta as Record<string, unknown> : undefined
      const delta = rawDelta ?? (row.message !== null && typeof row.message === 'object' ? row.message as Record<string, unknown> : {})
      const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : undefined
      if (typeof reasoning === 'string' && reasoning !== '') {
        reasoningBlock ??= open('reasoning')
        if (reasoningBlock.text === '') yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }
      const content = contentText(delta.content)
      if (content !== undefined && content !== '') {
        textBlock ??= open('text')
        if (textBlock.text === '') yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }
      const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
      for (const value of calls) {
        if (value === null || typeof value !== 'object') continue
        const call = value as Record<string, unknown>
        // Providers that omit tool_calls[].index are keyed by their call id
        // (or a single shared bucket when they emit neither field) instead of
        // collapsing every parallel call into ordinal 0.
        const ordinalKey = typeof call.index === 'number'
          ? `i:${call.index}`
          : typeof call.id === 'string' && call.id !== '' ? `id:${call.id}` : 'call'
        let block = tools.get(ordinalKey)
        if (block === undefined) { block = open('tool-call'); tools.set(ordinalKey, block); yield { type: 'block-start', index: block.index, blockType: 'tool-call' } }
        if (typeof call.id === 'string' && call.id !== '') block.callId = call.id
        const fn = call.function !== null && typeof call.function === 'object' ? call.function as Record<string, unknown> : {}
        if (typeof fn.name === 'string' && fn.name !== '') block.name = fn.name
        const fragment = typeof fn.arguments === 'string'
          ? fn.arguments
          // Some non-conformant gateways, and the non-streaming fallback read
          // through `row.message` above, send the assembled arguments as a
          // JSON value instead of a string fragment. Reading only strings made
          // those arguments vanish and turned the call into a no-argument one,
          // which is the same silent distortion the Anthropic wire had; a
          // re-serialized value keeps the call intact and stays a string.
          : fn.arguments === undefined || fn.arguments === null ? '' : JSON.stringify(fn.arguments)
        block.text += fragment
        yield { type: 'tool-call-delta', index: block.index, id: callIdFor(block), ...(block.name === undefined ? {} : { name: block.name }), argumentsDelta: fragment }
      }
      if (typeof row.finish_reason === 'string') pendingFinish = finishReason(row.finish_reason)
    }
    pendingUsage = usage(chunk.usage) ?? pendingUsage
  }
  // A provider may omit the [DONE] sentinel after its final chunk. Content
  // already reached the caller, so terminate gracefully instead of failing
  // the turn; only a stream that produced nothing is treated as closed.
  if (order.length === 0 && pendingUsage === undefined && pendingFinish === undefined) {
    throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED')
  }
  // Tolerating the missing sentinel means trusting the final chunk's own
  // `finish_reason` to say the turn ended. Content with no finish reason and no
  // sentinel is not that case: the connection died mid-answer, and reporting it
  // as `stop` handed the caller a truncated reply with nothing to show that
  // anything had been lost.
  if (order.length > 0 && pendingFinish === undefined) {
    throw new LlmError('SSE payload stream ended mid-answer without [DONE] or a finish reason', 'STREAM_CLOSED')
  }
  yield* terminal()
}
