/**
 * The TRAE SOLO chat bridge: request assembly, the header set the conversation
 * endpoint authenticates with, and the reader that re-emits upstream frames as
 * OpenAI SSE.
 *
 * The rewrite is one-way and single-pass: the Harness speaks the OpenAI body
 * shape, SOLO wants the same conversation in its own envelope, and the pieces
 * that differ are the interesting ones — content becomes typed blocks, the
 * model id is stated twice (as `model` and as `config_name`), tools carry their
 * schema as a *string*, and an assistant turn's tool calls travel as
 * `function_call` rather than `function`. Everything else in the body is passed
 * through, which is how the upstream tolerates the OpenAI fields it does not
 * read.
 *
 * Why the stream is framed here rather than by the shared reader
 * --------------------------------------------------------------
 * `wire-shared.parseSse` yields `data` payloads only, because the two dialects
 * it serves route on the payload. SOLO routes on the `event:` name: `output`
 * carries content, `token_usage` the counts, `done` the finish reason, and
 * `error` a business code. A payload-only reader sees four indistinguishable
 * JSON documents, so this module frames the wire itself and re-emits standard
 * OpenAI frames for `translate()` to read.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/trae/bridge
 */

import { asNumber, asRecord, asString } from '../untrusted-json.ts'
import { DONE } from '../wire-shared.ts'
import {
  TRAE_APP_ID,
  TRAE_APP_VERSION,
  TRAE_DEVICE_BRAND,
  TRAE_DEVICE_TYPE,
  TRAE_FUNCTION,
  TRAE_OS_VERSION,
  traeChatUrl,
} from './endpoints.ts'
import { randomBytes } from 'node:crypto'
import { withTraeThinkEffort } from './reasoning.ts'
import { TraeUpstreamError } from './errors.ts'
import { traeIdeVersionCode, traeRealmConfig } from './realms.ts'
import type { TraeAccount } from './types.ts'

/** The upstream event names this bridge reads; the rest are acknowledged. */
const TRAE_EVENT_OUTPUT = 'output'
const TRAE_EVENT_USAGE = 'token_usage'
const TRAE_EVENT_DONE = 'done'
const TRAE_EVENT_ERROR = 'error'

/**
 * The header set one SOLO request carries.
 * @param account - the account whose session signs the request.
 * @param stream - whether the caller reads an event stream.
 * @param extra - additional headers, merged last.
 * @returns the headers.
 */
export function buildTraeSoloHeaders(
  account: TraeAccount,
  stream: boolean,
  extra?: Readonly<Record<string, string>>,
): Record<string, string> {
  const config = traeRealmConfig(account.realm)
  const versionCode = traeIdeVersionCode(account.realm)
  // A per-request trace pair, as the official clients send. Sent rather than
  // stowed because the upstream's own logs key on it, and because a request with
  // no trace id is one the client never made.
  const traceId = randomBytes(16).toString('hex')
  const spanId = randomBytes(8).toString('hex')
  return {
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
    'user-agent': `Trae/${config.ideVersion}`,
    // Three spellings of one access token: the conversation endpoint reads all
    // three, and the reference client sends all three.
    authorization: `Cloud-IDE-JWT ${account.accessToken}`,
    'x-cloudide-token': account.accessToken,
    'x-ide-token': account.accessToken,
    ...(account.uid === '' ? {} : { 'x-uid': account.uid }),
    'x-app-id': TRAE_APP_ID,
    'x-app-version': TRAE_APP_VERSION,
    'x-app-version-code': versionCode,
    'x-ide-version': config.ideVersion,
    'x-ide-version-code': versionCode,
    'x-ide-version-type': 'stable',
    'x-device-type': TRAE_DEVICE_TYPE,
    'x-os-version': TRAE_OS_VERSION,
    'x-device-brand': TRAE_DEVICE_BRAND,
    'request-traffic-type': 'prod',
    'x-custom-trace-id': traceId,
    'x-flow-traceparent': `04-${traceId}-${spanId}-01`,
    ...(stream ? { 'x-request-id': traceId, 'x-trae-request-id': traceId } : {}),
    ...(account.machineId === '' ? {} : { 'x-machine-id': account.machineId }),
    ...(account.deviceId === '' ? {} : { 'x-device-id': account.deviceId }),
    ...extra,
  }
}

/** Flatten one message's content to the text SOLO transports as a block. */
export function traeContentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const block of value) {
    const text = asString(asRecord(block).text)
    if (text !== undefined) parts.push(text)
  }
  return parts.join('\n\n')
}

/**
 * Convert one OpenAI-format message into the SOLO message shape.
 *
 * An assistant turn that used tools keeps them, and keeps them in SOLO's
 * spelling: the upstream's own struct names the field `function_call` and
 * requires its `name`, so a call without one is dropped rather than sent to be
 * rejected for the whole request.
 * @param message - the untrusted message.
 * @returns the converted message, or `undefined` when it carries nothing.
 */
export function traeMessage(message: unknown): Record<string, unknown> | undefined {
  const row = asRecord(message)
  const role = asString(row.role) ?? ''
  const text = traeContentText(row.content)
  const converted: Record<string, unknown> = { role, content: text === '' ? '' : [{ type: 'text', text }] }
  if (role === 'tool') {
    const name = asString(row.name)
    const toolCallId = asString(row.tool_call_id)
    if (name !== undefined) converted.name = name
    if (toolCallId !== undefined) converted.tool_call_id = toolCallId
    return converted
  }
  if (role === 'assistant' && Array.isArray(row.tool_calls)) {
    const kept: Record<string, unknown>[] = []
    for (const rawCall of row.tool_calls) {
      const call = asRecord(rawCall)
      const fn = asRecord(call.function)
      const name = asString(fn.name)
      if (name === undefined || name.trim() === '') continue
      kept.push({
        ...(asString(call.id) === undefined ? {} : { id: call.id }),
        type: 'function',
        function_call: { name, arguments: asString(fn.arguments) ?? '{}' },
      })
    }
    if (kept.length > 0) converted.tool_calls = kept
  }
  // A message without text and without a tool call is a caller's empty turn;
  // SOLO rejects it, and dropping it is what an OpenAI passthrough does too.
  if (text === '' && converted.tool_calls === undefined && role !== 'tool') return undefined
  return converted
}

/**
 * Normalize `tool_choice` onto the three shapes SOLO accepts: absent, `auto`,
 * `required`, or a function's name. An OpenAI `{"type":"none"}` asks for no
 * tools at all, which SOLO spells by leaving `tools` out of the body.
 * @param body - the body being assembled, modified in place.
 */
function normalizeToolChoice(body: Record<string, unknown>): void {
  const raw = body.tool_choice
  if (raw === undefined) return
  if (typeof raw === 'string') {
    if (raw.toLowerCase() === 'none') {
      delete body.tool_choice
      delete body.tools
      delete body.functions
    }
    return
  }
  const choice = asRecord(raw)
  const type = (asString(choice.type) ?? '').toLowerCase()
  if (type === 'none') {
    delete body.tool_choice
    delete body.tools
    delete body.functions
    return
  }
  if (type === 'auto' || type === 'required') {
    body.tool_choice = type
    return
  }
  if (type === 'function') {
    const name = asString(asRecord(choice.function).name) ?? asString(choice.name) ?? ''
    body.tool_choice = name.trim() === '' ? 'auto' : name
    return
  }
  // Anything unrecognized is dropped rather than forwarded: the upstream
  // deserializes this field into a string and refuses the request otherwise.
  delete body.tool_choice
}

/**
 * Rewrite the tool declarations SOLO can read.
 *
 * The upstream deserializes `function.parameters` as a *string* while OpenAI
 * sends an object, so each schema is serialized. An entry that is not a
 * well-formed tool is dropped — one malformed declaration fails the whole
 * request, which would cost the turn rather than the single tool.
 * @param body - the body being assembled, modified in place.
 */
function normalizeTools(body: Record<string, unknown>): void {
  const raw = body.tools
  if (!Array.isArray(raw) || raw.length === 0) return
  const kept: Record<string, unknown>[] = []
  for (const item of raw) {
    const tool = asRecord(item)
    const fn = asRecord(tool.function)
    if (Object.keys(fn).length === 0) continue
    const name = asString(fn.name)
    if (name === undefined || name.trim() === '') continue
    const parameters = fn.parameters
    kept.push({
      type: 'function',
      function: {
        ...fn,
        name,
        ...(parameters === undefined || typeof parameters === 'string' ? {} : { parameters: JSON.stringify(parameters) }),
      },
    })
  }
  if (kept.length === 0) {
    delete body.tools
    return
  }
  body.tools = kept
}

/**
 * Assemble the SOLO conversation body from the OpenAI one.
 *
 * `stream` is forced on because the upstream only answers this entry point as an
 * event stream; a caller that asked for a single response is served by the
 * shared `translate()`, which aggregates the same frames.
 *
 * The reasoning effort is translated rather than forwarded, because SOLO has no
 * field to carry it: the level becomes a system-prompt block (see
 * `trae/reasoning.ts`) and the OpenAI field is removed rather than left for the
 * upstream to misread.
 * @param body - the OpenAI-shaped request body.
 * @param model - the model id both `model` and `config_name` must state.
 * @returns the body to send.
 */
export function prepareTraeBody(body: Record<string, unknown>, model: string): Record<string, unknown> {
  const prepared: Record<string, unknown> = { ...body }
  const effort = asString(prepared.reasoning_effort)
  delete prepared.reasoning_effort
  const messages: Record<string, unknown>[] = []
  for (const message of withTraeThinkEffort(Array.isArray(body.messages) ? body.messages : [], model, effort)) {
    const converted = traeMessage(message)
    if (converted !== undefined) messages.push(converted)
  }
  prepared.messages = messages
  prepared.stream = true
  prepared.function = TRAE_FUNCTION
  prepared.model = model
  prepared.config_name = model
  normalizeToolChoice(prepared)
  normalizeTools(prepared)
  return prepared
}

/** One upstream frame, with its event name preserved. */
export interface TraeSseEvent {
  readonly event: string
  readonly data: string
}

/**
 * Read the SOLO event stream into its named frames.
 *
 * Framing follows the wire: an `event:` line names the frame, `data:` lines
 * accumulate its payload, and a blank line ends it. A frame whose name arrived
 * without data still travels — `done` is the case that matters, and dropping it
 * would leave the caller without a finish reason.
 * @param stream - the response body to frame.
 * @returns each frame in arrival order.
 */
export async function* readTraeEvents(stream: ReadableStream<BufferSource>): AsyncGenerator<TraeSseEvent> {
  const decoder = new TextDecoder()
  let event = ''
  let data = ''
  let buffered = ''
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffered += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let newline = buffered.indexOf('\n')
      while (newline !== -1) {
        const line = buffered.slice(0, newline).replace(/\r$/u, '')
        buffered = buffered.slice(newline + 1)
        if (line === '') {
          if (event !== '') {
            yield { event, data }
            event = ''
            data = ''
          }
        } else if (line.startsWith('event:')) {
          event = line.slice('event:'.length).trim()
        } else if (line.startsWith('data:')) {
          data += line.slice('data:'.length).trim()
        }
        newline = buffered.indexOf('\n')
      }
      if (done) break
    }
    if (event !== '') yield { event, data }
  } finally {
    reader.releaseLock()
  }
}

/** A frame the bridge acts on; `undefined` means "acknowledged, carries nothing". */
export type TraeFrame =
  | { readonly kind: 'delta'; readonly content?: string; readonly reasoning?: string; readonly toolCalls?: readonly unknown[] }
  | { readonly kind: 'usage'; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly kind: 'done'; readonly finishReason: string }

/**
 * Parse one named frame.
 *
 * An `error` frame is thrown rather than returned: it is the upstream reporting
 * that the turn failed (a spent quota, a rate limit, a rejected model), and the
 * account pool classifies those to decide whether the next account should try.
 * @param frame - the framed event.
 * @returns the parsed frame, or `undefined` for the frames that carry nothing.
 * @throws TraeUpstreamError when the frame reports a failure.
 */
export function parseTraeFrame(frame: TraeSseEvent): TraeFrame | undefined {
  if (frame.data.trim() === '') return undefined
  let payload: Record<string, unknown>
  try {
    payload = asRecord(JSON.parse(frame.data))
  } catch {
    return undefined
  }
  switch (frame.event) {
    case TRAE_EVENT_OUTPUT: {
      const content = asString(payload.response)
      const reasoning = asString(payload.reasoning_content)
      const toolCalls = Array.isArray(payload.tool_calls) && payload.tool_calls.length > 0 ? payload.tool_calls : undefined
      if (content === undefined && reasoning === undefined && toolCalls === undefined) return undefined
      return {
        kind: 'delta',
        ...(content === undefined ? {} : { content }),
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(toolCalls === undefined ? {} : { toolCalls }),
      }
    }
    case TRAE_EVENT_USAGE:
      return {
        kind: 'usage',
        inputTokens: asNumber(payload.prompt_tokens) ?? 0,
        outputTokens: asNumber(payload.completion_tokens) ?? 0,
      }
    case TRAE_EVENT_DONE:
      return { kind: 'done', finishReason: asString(payload.finish_reason) ?? 'stop' }
    case TRAE_EVENT_ERROR: {
      const code = asNumber(payload.code)
      const message = asString(payload.message) ?? 'unknown'
      // A failure inside an accepted stream: the transport succeeded, so the
      // status this is reported under is the one a refusal would have carried.
      throw new TraeUpstreamError(502, `upstream error${code === undefined ? '' : ` code=${code}`}: ${message}`, code)
    }
    default:
      return undefined
  }
}

/**
 * The OpenAI SSE frames one SOLO frame maps to.
 *
 * Content and usage are separate frames because the shared reader emits a usage
 * chunk from a usage frame and would drop one that rode beside content.
 * @param frame - the parsed SOLO frame.
 * @returns zero, one, or two OpenAI SSE payloads.
 */
export function traeOpenAiFrames(frame: TraeFrame): readonly string[] {
  if (frame.kind === 'delta') {
    return [`data: ${JSON.stringify({
      choices: [{
        index: 0,
        delta: {
          ...(frame.content === undefined ? {} : { content: frame.content }),
          ...(frame.reasoning === undefined ? {} : { reasoning_content: frame.reasoning }),
          ...(frame.toolCalls === undefined ? {} : { tool_calls: frame.toolCalls }),
        },
      }],
    })}\n\n`]
  }
  if (frame.kind === 'usage') {
    return [`data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: frame.inputTokens, completion_tokens: frame.outputTokens },
    })}\n\n`]
  }
  return [`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: frame.finishReason }] })}\n\n`]
}

/**
 * Turn the SOLO event stream into the OpenAI-compatible stream `translate()`
 * reads.
 * @param events - the framed upstream events.
 * @returns the response body to hand the shared reader.
 */
export function synthesizeTraeOpenAiSse(events: AsyncIterable<TraeSseEvent>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of events) {
          const frame = parseTraeFrame(event)
          if (frame === undefined) continue
          if (frame.kind === 'done') {
            for (const text of traeOpenAiFrames(frame)) controller.enqueue(encoder.encode(text))
            break
          }
          for (const text of traeOpenAiFrames(frame)) controller.enqueue(encoder.encode(text))
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
 * Open one SOLO conversation stream.
 * @param account - the account whose session carries the turn.
 * @param body - the assembled SOLO body.
 * @param signal - aborts the request when the caller cancels.
 * @param extra - additional headers, merged last.
 * @returns the raw upstream response.
 */
export async function openTraeChatStream(
  account: TraeAccount,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  extra?: Readonly<Record<string, string>>,
): Promise<Response> {
  // The account's own realm decides the host. A China token sent to the
  // international host (or the reverse) is refused in a way that names the
  // credential rather than the routing.
  const response = await fetch(traeChatUrl(account.realm, account.userRegion), {
    method: 'POST',
    headers: buildTraeSoloHeaders(account, true, extra),
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new TraeUpstreamError(response.status, detail.slice(0, 400))
  }
  if (response.body === null) throw new TraeUpstreamError(502, 'empty upstream stream')
  return response
}
