/**
 * The Qoder chat bridge: request assembly and the SSE envelope reader.
 *
 * The upstream answers one OpenAI-shaped response wrapped in an envelope frame
 * (`{ headers, body: "<inner chunk>", statusCodeValue }`). HTTP 200 is the only
 * status the connection layer sees: a provider failure can arrive *inside* the
 * stream as a non-200 `statusCodeValue` or as an inner `{ code, message }`. Both
 * are surfaced here rather than silently ending the turn.
 *
 * This module reads that envelope and re-emits standard OpenAI SSE frames, so
 * the shared `translate()`/`parseSse()` machinery produces the Harness stream
 * chunks — one code path for content, reasoning, tool calls, and usage.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/qoder/bridge
 */

import { randomUUID } from 'node:crypto'
import { asNumber, asRecord, asString } from '../untrusted-json.ts'
import { DONE } from '../wire-shared.ts'
import { buildCosyHeaders, cosyEncode, cosyPathSig } from './cosy.ts'
import { qoderEndpoints } from './endpoints.ts'
import type { QoderDelta, QoderIdentity, QoderSession } from './types.ts'

/** A classified Qoder upstream failure. */
export class QoderUpstreamError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`Qoder upstream HTTP ${status}: ${detail}`)
    this.name = 'QoderUpstreamError'
  }
}

/** The identity-independent half of a Qoder chat request. */
export interface QoderChatInput {
  readonly messages: readonly unknown[]
  readonly tools?: unknown
  readonly model: string
  readonly maxTokens?: number
  readonly isReasoning: boolean
}

/** Normalize an OpenAI message's content to plain text. */
export function normalizeContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const block of value) {
    const text = asString(asRecord(block).text)
    if (text !== undefined) parts.push(text)
  }
  return parts.join('\n\n')
}

/** A blank `response_meta` block the upstream expects on every message. */
function blankResponseMeta(): Record<string, unknown> {
  return {
    id: '',
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      completion_tokens_details: { reasoning_tokens: 0 },
      prompt_tokens_details: { cached_tokens: 0 },
    },
  }
}

function structuredMessage(role: string, text: string): Record<string, unknown> {
  return { role, content: text, response_meta: blankResponseMeta(), reasoning_content_signature: '' }
}

function userMessage(text: string): Record<string, unknown> {
  return {
    role: 'user',
    content: '',
    contents: [{ type: 'text', text }],
    response_meta: blankResponseMeta(),
    reasoning_content_signature: '',
  }
}

/**
 * Convert one incoming OpenAI-format message into the Qoder message shape.
 * @param message - the untrusted message.
 * @param toolsEnabled - whether tool calls travel on this request.
 * @returns the converted message, or `undefined` when it carries no content.
 */
export function convertMessage(message: unknown, toolsEnabled: boolean): Record<string, unknown> | undefined {
  const row = asRecord(message)
  const role = asString(row.role) ?? ''
  const text = normalizeContent(row.content)
  if (role === 'assistant' && toolsEnabled && row.tool_calls !== undefined) {
    return { ...structuredMessage('assistant', text), tool_calls: row.tool_calls }
  }
  if (role === 'tool') {
    const out = structuredMessage('tool', text)
    const name = asString(row.name)
    const toolCallId = asString(row.tool_call_id)
    if (name !== undefined) out.name = name
    if (toolCallId !== undefined) out.tool_call_id = toolCallId
    return out
  }
  if (text === '') return undefined
  if (role === 'user') return userMessage(text)
  return structuredMessage(role, text)
}

/** The last user message's text, which the upstream echoes as the chat title. */
function lastUserPrompt(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const row = asRecord(messages[index])
    if (asString(row.role) === 'user') return normalizeContent(row.content)
  }
  return ''
}

/**
 * Assemble a full Qoder chat request body.
 * @param input - the messages, tools, model, and call knobs.
 * @param identity - the account's cosy identity.
 * @param defaults - `displayName`/`maxInputTokens`/template `maxTokens`.
 * @returns the request body to encode and sign.
 */
export function buildQoderChatBody(
  input: QoderChatInput,
  identity: QoderIdentity,
  defaults: { readonly displayName?: string; readonly maxInputTokens?: number; readonly defaultMaxTokens?: number } = {},
): Record<string, unknown> {
  const enabled = input.tools !== undefined && input.tools !== null
  const rebuilt: Record<string, unknown>[] = []
  for (const message of input.messages) {
    const converted = convertMessage(message, enabled)
    if (converted !== undefined) rebuilt.push(converted)
  }
  const prompt = lastUserPrompt(input.messages)
  const maxTokens = input.maxTokens !== undefined && input.maxTokens > 0
    ? input.maxTokens
    : defaults.defaultMaxTokens ?? 32768
  const requestId = randomUUID()
  const businessId = randomUUID()
  const title = prompt.length > 30 ? prompt.slice(0, 30) : prompt
  return {
    request_id: requestId,
    request_set_id: randomUUID(),
    chat_record_id: requestId,
    stream: true,
    chat_task: 'FREE_INPUT',
    chat_context: {
      chatPrompt: '',
      extra: {
        context: [],
        modelConfig: { is_reasoning: input.isReasoning, key: input.model },
        originalContent: { type: 'text', text: prompt },
      },
      features: [],
      imageUrls: null,
      text: { type: 'text', text: prompt },
    },
    image_urls: null,
    is_reply: true,
    is_retry: false,
    session_id: randomUUID(),
    code_language: '',
    source: 1,
    version: '3',
    chat_prompt: '',
    parameters: { max_tokens: maxTokens },
    aliyun_user_type: identity.userType,
    session_type: 'qoder',
    agent_id: 'agent_common',
    task_id: 'common',
    model_config: {
      key: input.model,
      display_name: defaults.displayName ?? '',
      model: '',
      format: 'openai',
      is_vl: false,
      is_reasoning: input.isReasoning,
      api_key: '',
      url: '',
      source: 'system',
      max_input_tokens: defaults.maxInputTokens ?? 180000,
    },
    messages: rebuilt,
    ...(enabled ? { tools: input.tools } : {}),
    business: {
      product: 'ide',
      version: '1.1.3',
      type: 'agent',
      id: businessId,
      name: title,
      begin_at: Date.now(),
      stage: 'start',
    },
  }
}

/** A parsed envelope frame: either a delta or an error already classified. */
export type QoderFrame =
  | { readonly kind: 'delta'; readonly delta: QoderDelta }
  | { readonly kind: 'done' }

/**
 * Parse one SSE `data:` payload from the Qoder stream.
 * @param payload - the raw event data (already stripped of the `data:` prefix).
 * @returns the parsed frame, or `undefined` for an empty keep-alive frame.
 * @throws QoderUpstreamError when the envelope or inner body reports a failure.
 */
export function parseQoderFrame(payload: string): QoderFrame | undefined {
  const trimmed = payload.trim()
  if (trimmed === '') return undefined
  // The shared sentinel rather than the literal: a second copy is a second answer
  // to "what ends a stream", and `wire-dialects-agree.spec.ts` requires exactly one
  // module to declare it.
  if (trimmed === DONE) return { kind: 'done' }
  let wrapper: Record<string, unknown>
  try {
    wrapper = asRecord(JSON.parse(trimmed))
  } catch {
    return undefined
  }
  const statusRaw = wrapper.statusCodeValue
  if (statusRaw !== undefined) {
    const status = typeof statusRaw === 'number' ? statusRaw : Number.parseInt(String(statusRaw), 10)
    const effective = Number.isFinite(status) ? status : 502
    if (effective !== 200) {
      const detail = asString(wrapper.body) ?? trimmed.slice(0, 400)
      throw new QoderUpstreamError(effective, detail)
    }
  }
  const inner = asString(wrapper.body)
  if (inner === undefined || inner === '') return undefined
  let innerJson: Record<string, unknown>
  try {
    innerJson = asRecord(JSON.parse(inner))
  } catch {
    return undefined
  }
  const usage = asRecord(innerJson.usage)
  const inputTokens = asNumber(usage.prompt_tokens) ?? 0
  const outputTokens = asNumber(usage.completion_tokens) ?? 0
  const choices = Array.isArray(innerJson.choices) ? innerJson.choices : []
  for (const choice of choices) {
    const delta = asRecord(asRecord(choice).delta)
    const role = asString(delta.role)
    const content = asString(delta.content)
    const reasoning = asString(delta.reasoning_content)
    const toolCalls = Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0 ? delta.tool_calls : undefined
    if (role !== undefined || content !== undefined || reasoning !== undefined || toolCalls !== undefined) {
      return {
        kind: 'delta',
        delta: {
          ...(role === undefined ? {} : { role }),
          ...(content === undefined ? {} : { content }),
          ...(reasoning === undefined ? {} : { reasoning }),
          ...(toolCalls === undefined ? {} : { toolCalls }),
          ...(inputTokens === 0 && outputTokens === 0 ? {} : { inputTokens, outputTokens }),
        },
      }
    }
  }
  const code = asString(innerJson.code)
  if (code !== undefined && code !== '' && code !== '0') {
    const message = asString(innerJson.message) ?? 'unknown'
    throw new QoderUpstreamError(502, `upstream error code=${code}: ${message}`)
  }
  if (inputTokens > 0 || outputTokens > 0) {
    return { kind: 'delta', delta: { inputTokens, outputTokens } }
  }
  return undefined
}

/**
 * The OpenAI SSE frames one Qoder delta maps to: content first, then a separate
 * usage frame.
 *
 * The upstream may put the final usage *in the same frame* as the last content
 * delta. Emitting only one of the two would either drop that content or lose the
 * token count, so both are always emitted when present.
 * @param delta - the parsed Qoder delta.
 * @returns zero, one, or two OpenAI SSE frames.
 */
function openAiFrames(delta: QoderDelta): readonly string[] {
  const frames: string[] = []
  const hasContent = delta.role !== undefined || delta.content !== undefined || delta.reasoning !== undefined || delta.toolCalls !== undefined
  if (hasContent) {
    const payload = {
      choices: [{
        index: 0,
        delta: {
          ...(delta.role === undefined ? {} : { role: delta.role }),
          ...(delta.content === undefined ? {} : { content: delta.content }),
          ...(delta.reasoning === undefined ? {} : { reasoning_content: delta.reasoning }),
          ...(delta.toolCalls === undefined ? {} : { tool_calls: delta.toolCalls }),
        },
      }],
    }
    frames.push(`data: ${JSON.stringify(payload)}\n\n`)
  }
  if (delta.inputTokens !== undefined || delta.outputTokens !== undefined) {
    const payload = { choices: [], usage: { prompt_tokens: delta.inputTokens ?? 0, completion_tokens: delta.outputTokens ?? 0 } }
    frames.push(`data: ${JSON.stringify(payload)}\n\n`)
  }
  return frames
}

/**
 * Turn the upstream SSE payload stream into an OpenAI-compatible SSE stream.
 * @param payloads - the `data:` payloads from the Qoder response.
 * @returns the response body the shared `parseSse`/`translate` can read.
 */
export function synthesizeOpenAiSse(payloads: AsyncIterable<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const payload of payloads) {
          const frame = parseQoderFrame(payload)
          if (frame === undefined) continue
          if (frame.kind === 'done') break
          for (const text of openAiFrames(frame.delta)) controller.enqueue(encoder.encode(text))
        }
        controller.enqueue(encoder.encode(`data: ${DONE}\n\n`))
        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
  })
}

/**
 * Open one cosy-signed chat stream and wrap it as an OpenAI-compatible response.
 * @param session - the account session.
 * @param body - the assembled Qoder request body.
 * @param signal - aborts the request.
 * @param extra - additional headers (e.g. attribution) merged last.
 * @returns the raw upstream response.
 */
export async function openQoderChatStream(
  session: QoderSession,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  extra?: Readonly<Record<string, string>>,
): Promise<Response> {
  const url = qoderEndpoints(session.region).chatStreamUrl
  const bodyStr = cosyEncode(Buffer.from(JSON.stringify(body), 'utf8'))
  const headers = buildCosyHeaders(session, cosyPathSig(url), bodyStr, 'text/event-stream', {
    'x-model-key': asString(asRecord(body.model_config).key) ?? '',
    'x-model-source': 'system',
    ...extra,
  })
  const response = await fetch(url, { method: 'POST', headers, body: bodyStr, ...(signal === undefined ? {} : { signal }) })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new QoderUpstreamError(response.status, detail.slice(0, 400))
  }
  if (response.body === null) throw new QoderUpstreamError(502, 'empty upstream stream')
  return response
}
