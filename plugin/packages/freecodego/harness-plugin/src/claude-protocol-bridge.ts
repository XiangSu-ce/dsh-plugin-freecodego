import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { tokensFromChars } from './token-estimate.ts'
import { StreamWriter } from './stream-writer.ts'
import { withIdleDeadline } from './stream-deadline.ts'
import { classifyProviderError } from './provider-error-classify.ts'
import { redactCredentialShapes } from './secret-scan.ts'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, Message, StreamChunk, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

type LlmRuntime = { stream(options: GenerateOptions): AsyncIterable<StreamChunk> }
type BridgeReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type Route = { readonly provider: string; readonly model: string; readonly reasoningEffort?: BridgeReasoningEffort; readonly dynamicOpenAiRoute?: boolean; readonly createdAt: number }
const ROUTE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * How long a bridge stream may produce nothing before the turn is failed.
 *
 * Two minutes of silence on a streaming route is not slowness: a healthy turn
 * emits chunks continuously, and the only other reason for a gap this long is a
 * connection that has been dropped without a close. Without a bound here the
 * client waits forever, because nothing above this layer can tell "slow" from
 * "gone" — see `stream-deadline.ts` for why the deadline is idle-based.
 */
export const DEFAULT_STREAM_IDLE_MS = 120_000

/**
 * The route id a saved bridge endpoint names.
 *
 * The URL shape is the bridge's own (`/anthropic/<id>`), and a stored endpoint may
 * or may not carry the `/v1` its callers join on, so this reads the id out of both
 * spellings. Exported beside {@link ClaudeProtocolBridge.hasRoute} because the
 * grammar lives here: a second parser elsewhere would be the copy that drifts the
 * day a route path changes.
 *
 * The id is spelled as a UUID because that is what {@link ClaudeProtocolBridge.endpoint}
 * mints and what `hasRoute` is keyed by, and the difference is load-bearing: an
 * Anthropic-compatible provider's own URL (`https://api.deepseek.com/anthropic/v1`)
 * ends in the same version token a bridge URL's suffix uses, so a grammar loose enough
 * to accept any last segment reads that `/v1` as a route id. Callers use a match here
 * to decide "this is my route, and I may rebuild it", and a false match there is a boot
 * pass rewriting an endpoint that was never its own.
 * @param baseURL - a stored endpoint.
 * @returns the route id it names, or undefined when it is not a bridge URL.
 */
export function bridgeRouteIdOf(baseURL: string): string | undefined {
  const match = /\/anthropic\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/v1)?\/?$/iu.exec(baseURL.trim())
  return match?.[1]
}

function callId(value: string): never { return value as never }

/**
 * Compare a credential a client presented against the bridge's own secret.
 *
 * `===` on two strings stops at the first differing character, so how long a
 * rejected guess takes is a function of how many leading characters it got
 * right. This listener is loopback-only but not owner-only — every local
 * process can sample it — so the comparison runs over fixed-length SHA-256
 * digests instead: equal length is what `timingSafeEqual` requires, and
 * hashing first also keeps the secret's own length out of the comparison.
 * `browser-auth.ts` guards this repository's other loopback listener the same
 * way, and this bridge is the one place that did not.
 */
function secretMatches(presented: unknown, secret: string): boolean {
  if (typeof presented !== 'string') return false
  return timingSafeEqual(
    createHash('sha256').update(presented, 'utf8').digest(),
    createHash('sha256').update(secret, 'utf8').digest(),
  )
}

/** Local-only Anthropic Messages facade used by the Claude Agent SDK fallback path. */
export class ClaudeProtocolBridge {
  private server: Server | undefined
  private address: string | undefined
  // The `sk-ant-api03-` shape is load-bearing, but not for the reason a
  // pre-flight rejection would imply. Claude Code 2.1.246 resolves the key with
  // no shape check and sends it as `x-api-key` — its own auth builder only
  // fails on a *missing* key — so the prefix is not what authenticates this
  // facade. What it does is flip the CLI's first-party detector, which is
  // literally `key.startsWith('sk-ant-') && key.slice(7, 10) === 'api'`, and
  // that predicate gates small/fast-model resolution and other first-party
  // branches. This remains a process-local bridge secret only.
  private readonly secret = `sk-ant-api03-${randomBytes(32).toString('base64url')}`
  private readonly routes = new Map<string, Route>()
  private readyPromise: Promise<void> | undefined

  constructor(private readonly llm: LlmRuntime, private readonly streamIdleMs: number = DEFAULT_STREAM_IDLE_MS) {}

  /** Start the local bridge listener, resolving once it is accepting connections. */
  start(): Promise<void> {
    return this.readyPromise ??= new Promise((resolve, reject) => {
      const server = createServer((req, res) => { void this.handle(req, res).catch((error: unknown) => { this.fail(res, error) }) })
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        const port = (server.address() as { port: number }).port
        this.server = server
        this.address = `http://127.0.0.1:${port}`
        resolve()
      })
    })
  }

  /** Close the listener and drop its routes and cached readiness. */
  async dispose(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.address = undefined
    this.routes.clear()
    // The cached readiness goes with the server it describes. Left behind, a later
    // `endpoint()` awaits a promise that resolved for a listener which no longer
    // exists, then builds its URL from an `undefined` address — a route that looks
    // usable to the caller and answers nothing.
    this.readyPromise = undefined
    if (server !== undefined) await new Promise<void>(resolve => server.close(() => { resolve() }))
  }

  /** Mint an Anthropic-wire endpoint for one provider/model route.
   * @param provider - provider id the turn is routed to.
   * @param model - model id the turn runs.
   * @param reasoningEffort - the reasoning effort to pin, when the route names one.
   * @returns the endpoint base URL and its bridge API key.
   */
  async endpoint(provider: string, model: string, reasoningEffort?: string): Promise<{ readonly baseURL: string; readonly apiKey: string }> {
    await this.start()
    this.pruneRoutes()
    const id = randomUUID()
    this.routes.set(id, { provider, model, ...(isBridgeReasoningEffort(reasoningEffort) ? { reasoningEffort } : {}), createdAt: Date.now() })
    return { baseURL: `${this.address}/anthropic/${id}`, apiKey: this.secret }
  }

  /** Mint the session's OpenAI-wire endpoint, whose model field carries later route tags.
   * @param provider - the initial provider id the session routes to.
   * @param model - the initial model id the session runs.
   * @returns the endpoint base URL and its bridge API key.
   */
  async openAIEndpoint(provider: string, model: string): Promise<{ readonly baseURL: string; readonly apiKey: string }> {
    await this.start()
    this.pruneRoutes()
    const id = randomUUID()
    // Codex keeps one local OpenAI endpoint for a session. Route tags on its
    // model field let every later prompt select a new Harness provider/model.
    this.routes.set(id, { provider, model, dynamicOpenAiRoute: true, createdAt: Date.now() })
    return { baseURL: `${this.address}/openai/${id}/v1`, apiKey: this.secret }
  }

  /**
   * Whether this process still serves a route id.
   *
   * A route belongs to the listener that minted it: `dispose()` clears the map and
   * a new process mints new ids and a new port, so a saved endpoint whose id is
   * absent here answers nothing. That is the question a binding written before a
   * restart has to ask before it can be kept — see `web-search-binding.ts` — and
   * it is asked of the bridge rather than of a copy of the map, because only the
   * bridge knows when a route expired.
   * @param id - route id parsed off a saved endpoint ({@link bridgeRouteIdOf}).
   * @returns whether this bridge would answer for it.
   */
  hasRoute(id: string): boolean {
    this.pruneRoutes()
    return this.routes.has(id)
  }

  /** Drop routes older than the TTL so a long-lived bridge cannot leak them. */
  private pruneRoutes(): void {
    const cutoff = Date.now() - ROUTE_TTL_MS
    for (const [id, route] of this.routes) {
      if (route.createdAt <= cutoff) this.routes.delete(id)
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? '/', 'http://bridge').pathname
    const isAnthropic = /^\/anthropic\/([^/]+)\/v1\/messages$/.exec(pathname)
    const isAnthropicCountTokens = /^\/anthropic\/([^/]+)\/v1\/messages\/count_tokens$/.exec(pathname)
    const isOpenAI = /^\/openai\/([^/]+)\/v1\/responses$/.exec(pathname)
    const authorization = req.headers.authorization
    const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined
    if (req.method !== 'POST' || (!secretMatches(req.headers['x-api-key'], this.secret) && !secretMatches(bearer, this.secret))) {  this.json(res, 404, { error: { type: 'not_found', message: 'bridge route not found' } }); return }
    const match = isAnthropic ?? isAnthropicCountTokens ?? isOpenAI
    if (match === null) {  this.json(res, 404, { error: { type: 'not_found', message: 'bridge endpoint not found' } }); return }
    const route = this.routes.get(match[1]!)
    if (route === undefined) {  this.json(res, 404, { error: { type: 'not_found', message: 'bridge route expired' } }); return }
    const body = JSON.parse(await readBody(req, 64 * 1024 * 1024)) as Record<string, unknown>
    // Relay client disconnects into the upstream stream so a cancelled Claude
    // Code turn stops consuming provider tokens instead of running to completion.
    const abort = new AbortController()
    req.on('close', () => { if (!res.writableEnded) abort.abort(new Error('bridge client disconnected')) })
    const attachSignal = (options: GenerateOptions): GenerateOptions => ({ ...options, signal: abort.signal })
    if (isAnthropicCountTokens !== null) {  this.json(res, 200, { input_tokens: estimateAnthropicInputTokens(body) }); return }
    const resolvedRoute = isOpenAI === null ? route : resolveOpenAiRoute(route, body)
    const input = attachSignal(isOpenAI === null ? toGenerateOptions(resolvedRoute, body) : toResponsesGenerateOptions(resolvedRoute, body))
    if (body.stream === false) {
      const chunks = await collect(this.llm.stream(input))
      const failure = chunks.find((chunk): chunk is Extract<StreamChunk, { type: 'finish' }> => chunk.type === 'finish' && chunk.reason.kind === 'error')
      if (failure !== undefined) {  this.json(res, 502, { error: { type: 'api_error', message: redactCredentialShapes((failure.reason as Extract<FinishReason, { kind: 'error' }>).failure.message) } }); return }
      this.json(res, 200, isOpenAI === null ? toNonStreamingResponse(chunks, resolvedRoute.model) : toResponsesObject(chunks, resolvedRoute.model)); return
    }
    await this.streamResponse(res, this.llm.stream(input), resolvedRoute.model, isOpenAI !== null)
  }  private async streamResponse(res: ServerResponse, stream: AsyncIterable<StreamChunk>, model: string, responses = false): Promise<void> {
    if (responses) return this.streamResponsesResponse(res, stream, model)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    // Every write to this response goes through one writer: the chunk loop and
    // the failure path below both end the turn, and only one of them may.
    const writer = new StreamWriter(res)
    writeEvent(writer, 'message_start', { type: 'message_start', message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })
    const open = new Set<number>()
    // Tool-call block-start carries no id/name; buffer the block until the
    // first delta reveals the provider call id, then open with the real one.
    const pending = new Map<number, { id?: string; name?: string; args: string; sent: boolean }>()
    let stopReason = 'end_turn'
    let lastUsage: TokenUsage | undefined
    let failureMessage: string | undefined
    const startTool = (index: number, call: { readonly id?: string; readonly name?: string; readonly args?: string }): void => {
      writeEvent(writer, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id ?? `tool_${randomUUID()}`, name: call.name ?? 'tool', input: {} } })
      // An id that never arrived still has to be substituted, and the arguments
      // buffered before it arrived still have to be delivered — as the opening
      // json delta. Without this the client receives a `tool_use` whose `input`
      // is `{}` and runs the tool with no arguments at all. Host providers do
      // stream an empty id (`llm-deepseek`, `llm-pi-ai` both fall back to `''`),
      // so this is the normal path for them, not a defensive branch.
      if (call.args !== undefined && call.args !== '') writeEvent(writer, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: call.args } })
    }
    // A provider that throws mid-stream — or stops answering — must not leave the
    // response open: the failure is recorded and turned into the protocol's own
    // error frame at the end of this method.
    let failure: unknown
    try {
      for await (const chunk of this.bounded(stream)) {
        if (chunk.type === 'block-start') {
          open.add(chunk.index)
          if (chunk.blockType === 'tool-call') pending.set(chunk.index, { args: '', sent: false })
          else if (chunk.blockType === 'reasoning') writeEvent(writer, 'content_block_start', { type: 'content_block_start', index: chunk.index, content_block: { type: 'thinking', thinking: '', signature: '' } })
          else writeEvent(writer, 'content_block_start', { type: 'content_block_start', index: chunk.index, content_block: { type: 'text', text: '' } })
        } else if (chunk.type === 'text-delta') {
          if (!open.has(chunk.index)) { open.add(chunk.index); writeEvent(writer, 'content_block_start', { type: 'content_block_start', index: chunk.index, content_block: { type: 'text', text: '' } }) }
          writeEvent(writer, 'content_block_delta', { type: 'content_block_delta', index: chunk.index, delta: { type: 'text_delta', text: chunk.text } })
        } else if (chunk.type === 'reasoning-delta') {
          if (!open.has(chunk.index)) { open.add(chunk.index); writeEvent(writer, 'content_block_start', { type: 'content_block_start', index: chunk.index, content_block: { type: 'thinking', thinking: '', signature: '' } }) }
          writeEvent(writer, 'content_block_delta', { type: 'content_block_delta', index: chunk.index, delta: { type: 'thinking_delta', thinking: chunk.text } })
        } else if (chunk.type === 'tool-call-delta') {
          const call = pending.get(chunk.index) ?? { args: '', sent: false }
          pending.set(chunk.index, call)
          open.add(chunk.index)
          if (chunk.id !== '') call.id = chunk.id
          if (chunk.name !== undefined) call.name = chunk.name
          call.args += chunk.argumentsDelta
          if (!call.sent && call.id !== undefined) {
            call.sent = true
            startTool(chunk.index, call)
          } else if (call.sent) {
            writeEvent(writer, 'content_block_delta', { type: 'content_block_delta', index: chunk.index, delta: { type: 'input_json_delta', partial_json: chunk.argumentsDelta } })
          }
        } else if (chunk.type === 'block-end') {
          const call = pending.get(chunk.index)
          if (call !== undefined && !call.sent) { call.sent = true; startTool(chunk.index, call) }
          open.delete(chunk.index)
          writeEvent(writer, 'content_block_stop', { type: 'content_block_stop', index: chunk.index })
        } else if (chunk.type === 'usage') {
          lastUsage = chunk.usage
        } else if (chunk.type === 'finish') {
          if (chunk.reason.kind === 'error') failureMessage = chunk.reason.failure.message
          else stopReason = chunk.reason.kind === 'tool-calls' ? 'tool_use' : chunk.reason.kind === 'max-tokens' ? 'max_tokens' : 'end_turn'
        }
      }
    } catch (error) {
      failure = error
    }
    for (const index of open) {
      const call = pending.get(index)
      if (call !== undefined && !call.sent) { call.sent = true; startTool(index, call) }
      writeEvent(writer, 'content_block_stop', { type: 'content_block_stop', index })
    }
    // An upstream failure must reach the client as an Anthropic error event,
    // not as a normal empty turn, so the caller can retry.
    if (failureMessage !== undefined) {
      writeEvent(writer, 'error', { type: 'error', error: { type: 'api_error', message: redactCredentialShapes(failureMessage) } })
      writer.finish()
      return
    }
    if (failure !== undefined) {
      const verdict = classifyProviderError(failure)
      // A cancelled turn ends silently and without a terminal frame: the client
      // that asked for the cancellation is not waiting to be told about it, and
      // an error frame there is an error the caller caused.
      if (verdict.cancellation) { writer.finish(); return }
      writeEvent(writer, 'error', { type: 'error', error: { type: verdict.wireType, message: redactCredentialShapes(verdict.message) } })
      writer.finish()
      return
    }
    // The terminal message_delta carries the full usage snapshot; the interim
    // usage chunk only reports the running output count, and repeating it here
    // would clobber the real input/cache numbers Claude Code accumulates.
    writeEvent(writer, 'message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: {
      input_tokens: lastUsage?.inputTokens ?? 0,
      output_tokens: lastUsage?.outputTokens ?? 0,
      ...(lastUsage?.cacheReadTokens === undefined ? {} : { cache_read_input_tokens: lastUsage.cacheReadTokens }),
      ...(lastUsage?.cacheWriteTokens === undefined ? {} : { cache_creation_input_tokens: lastUsage.cacheWriteTokens }),
    } })
    writeEvent(writer, 'message_stop', { type: 'message_stop' })
    writer.finish()
  }

  /** The upstream stream, with its idle deadline applied. */
  private bounded(stream: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    return withIdleDeadline(stream, this.streamIdleMs)
  }

  private async streamResponsesResponse(res: ServerResponse, stream: AsyncIterable<StreamChunk>, model: string): Promise<void> {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const writer = new StreamWriter(res)
    const responseId = `resp_${randomUUID()}`
    const itemId = `msg_${randomUUID()}`
    writeData(writer, { type: 'response.created', response: { id: responseId, object: 'response', status: 'in_progress', model, output: [] } })
    writeData(writer, { type: 'response.output_item.added', output_index: 0, item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } })
    writeData(writer, { type: 'response.content_part.added', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } })
    let text = ''
    let stopReason = 'completed'
    let failureMessage: string | undefined
    let lastUsage: { inputTokens: number; outputTokens: number } | undefined
    const calls = new Map<number, { readonly itemIndex: number; readonly itemId: string; id: string; name: string; args: string; announced: boolean }>()
    // output_index 0 belongs to the message item announced above.
    let nextCall = 1
    let failure: unknown
    try {
      for await (const chunk of this.bounded(stream)) {
        if (chunk.type === 'text-delta') {
          text += chunk.text
          writeData(writer, { type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: chunk.text })
        } else if (chunk.type === 'reasoning-delta') {
          writeData(writer, { type: 'response.reasoning_summary_text.delta', item_id: itemId, output_index: 0, summary_index: 0, delta: chunk.text })
        } else if (chunk.type === 'tool-call-delta') {
          stopReason = 'tool_calls'
          let call = calls.get(chunk.index)
          if (call === undefined) { call = { itemIndex: nextCall++, itemId: `fc_${randomUUID()}`, id: '', name: chunk.name ?? 'tool', args: '', announced: false }; calls.set(chunk.index, call) }
          if (chunk.id !== '') call.id = chunk.id
          if (chunk.name !== undefined) call.name = chunk.name
          call.args += chunk.argumentsDelta
          if (!call.announced) {
            call.announced = true
            writeData(writer, { type: 'response.output_item.added', output_index: call.itemIndex, item: { id: call.itemId, type: 'function_call', status: 'in_progress', call_id: call.id, name: call.name ?? 'tool', arguments: '' } })
          }
          writeData(writer, { type: 'response.function_call_arguments.delta', item_id: call.itemId, output_index: call.itemIndex, delta: chunk.argumentsDelta })
        } else if (chunk.type === 'usage') {
          lastUsage = chunk.usage
        } else if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
          stopReason = 'failed'
          failureMessage = chunk.reason.failure.message
        }
      }
    } catch (error) {
      // Recorded rather than thrown: the item frames the failure payload needs
      // are assembled below, and a response.failed with an empty output would
      // lose what the client already received.
      failure = error
    }
    const thrown = failure === undefined ? undefined : classifyProviderError(failure)
    if (thrown?.cancellation === true) {
      // Nobody is listening for this one; see the Anthropic path.
      writer.finish()
      return
    }
    if (thrown !== undefined) {
      stopReason = 'failed'
      failureMessage = thrown.message
    }
    writeData(writer, { type: 'response.output_text.done', item_id: itemId, output_index: 0, content_index: 0, text })
    writeData(writer, { type: 'response.content_part.done', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text } })
    const messageItem = { id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text }] }
    writeData(writer, { type: 'response.output_item.done', output_index: 0, item: messageItem })
    const callItems: Record<string, unknown>[] = []
    for (const call of [...calls.values()].sort((a, b) => a.itemIndex - b.itemIndex)) {
      const item = { id: call.itemId, type: 'function_call', status: 'completed', call_id: call.id, name: call.name ?? 'tool', arguments: call.args }
      callItems.push(item)
      writeData(writer, { type: 'response.function_call_arguments.done', item_id: call.itemId, output_index: call.itemIndex, arguments: call.args })
      writeData(writer, { type: 'response.output_item.done', output_index: call.itemIndex, item })
    }
    const usage = { input_tokens: lastUsage?.inputTokens ?? 0, output_tokens: lastUsage?.outputTokens ?? 0, total_tokens: (lastUsage?.inputTokens ?? 0) + (lastUsage?.outputTokens ?? 0) }
    // An upstream failure must reach the client as response.failed with the
    // provider error, not as a completed response, so the caller can retry.
    // The `[DONE]` sentinel is the terminal frame, so it is delivered through the
    // writer like every other frame rather than by ending the response directly:
    // a second terminal source is exactly what the writer exists to refuse, and a
    // direct `res.end` would leave its accounting claiming the stream never finished.
    if (stopReason === 'failed') {
      writeData(writer, { type: 'response.failed', response: { id: responseId, object: 'response', status: 'failed', model, output: [messageItem, ...callItems], usage, error: { code: 'api_error', message: redactCredentialShapes(failureMessage ?? 'model request failed') } } })
      writer.finish('data: [DONE]\n\n')
      return
    }
    writeData(writer, { type: 'response.completed', response: { id: responseId, object: 'response', status: 'completed', model, output: [messageItem, ...callItems], usage } })
    writer.finish('data: [DONE]\n\n')
  }

  private json(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
  // The bridge's own `sk-ant-` secret travels as a request header, so anything
  // thrown while handling a request — a body parse, a provider failure — can
  // quote it back to the client that sent it.
  private fail(res: ServerResponse, error: unknown): void { if (res.headersSent) { res.end(); return }; this.json(res, 500, { error: { type: 'api_error', message: redactCredentialShapes(error instanceof Error ? error.message : String(error)) } }) }
}

/** Encode a model route for Codex's fixed local OpenAI endpoint. 
 * @param provider - provider id the turn is routed to.
 * @param model - model id the turn runs.
 * @param reasoningEffort - the reasoning effort to encode, when one is pinned.
 * @returns the encoded route tag.
 */
export function encodeCodexBridgeRoute(provider: string, model: string, reasoningEffort?: string): string {
  const effort = isBridgeReasoningEffort(reasoningEffort) ? `.${reasoningEffort}` : ''
  return `freecodego-route:${Buffer.from(provider, 'utf8').toString('base64url')}.${Buffer.from(model, 'utf8').toString('base64url')}${effort}`
}

function resolveOpenAiRoute(route: Route, body: Record<string, unknown>): Route {
  if (!route.dynamicOpenAiRoute || typeof body.model !== 'string') return route
  const value = /^freecodego-route:([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)(?:\.(off|low|medium|high|xhigh|max))?$/.exec(body.model)
  if (value === null) return route
  try {
    const provider = Buffer.from(value[1]!, 'base64url').toString('utf8').trim()
    const model = Buffer.from(value[2]!, 'base64url').toString('utf8').trim()
    if (provider === '' || model === '' || provider.length > 256 || model.length > 512) return route
    return { ...route, provider, model, ...(isBridgeReasoningEffort(value[3]) ? { reasoningEffort: value[3] } : {}) }
  } catch {
    return route
  }
}

function toGenerateOptions(route: Route, body: Record<string, unknown>): GenerateOptions {
  const messages = Array.isArray(body.messages) ? body.messages.flatMap(value => anthropicMessages(value)) : []
  const system = anthropicSystem(body.system)
  const tools = Array.isArray(body.tools) ? body.tools.map((value) => { const item = value as Record<string, unknown>; return { name: String(item.name ?? 'tool'), description: String(item.description ?? ''), parameters: (item.input_schema ?? {}) as Record<string, unknown> } satisfies ToolSchema }) : undefined
  return {
    provider: route.provider,
    model: route.model,
    messages,
    ...(system === undefined ? {} : { system }),
    ...(tools === undefined ? {} : { tools }),
    ...(typeof body.max_tokens === 'number' ? { maxTokens: body.max_tokens } : {}),
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }),
  }
}

function anthropicSystem(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value
  if (!Array.isArray(value)) return undefined
  const text = value
    .filter((block): block is Record<string, unknown> => block !== null && typeof block === 'object' && !Array.isArray(block))
    .filter(block => block.type === undefined || block.type === 'text')
    .map(block => typeof block.text === 'string' ? block.text : '')
    .filter(text => text.trim() !== '')
    .join('\n\n')
  return text === '' ? undefined : text
}

function estimateAnthropicInputTokens(body: Record<string, unknown>): number {
  const text = JSON.stringify({ system: body.system, messages: body.messages, tools: body.tools })
  // The `1` floor is this caller's, not the estimator's: a request with an
  // empty body still carries framing the provider bills for.
  return Math.max(1, tokensFromChars(text.length))
}

function toResponsesGenerateOptions(route: Route, body: Record<string, unknown>): GenerateOptions {
  const messages: Message[] = []
  if (typeof body.instructions === 'string' && body.instructions.trim() !== '') messages.push(createUserMessage({ content: [{ type: 'text', text: body.instructions }], source: { kind: 'user' } }))
  if (Array.isArray(body.input)) {
    for (const value of body.input) {
      const item = value as Record<string, unknown>
      if (item.type === 'function_call') {
        messages.push(createAssistantMessage({ content: [{ type: 'tool-call', id: callId(String(item.call_id ?? item.id ?? 'tool')), name: String(item.name ?? 'tool'), arguments: String(item.arguments ?? '') }], source: { provider: 'bridge', model: 'bridge' } }))
        continue
      }
      if (item.type === 'function_call_output') {
        const call = String(item.call_id ?? 'tool')
        // A function-call output is a tool result, and a tool result is its own
        // role message now: the call it answers is named by `toolCallId` on the
        // message rather than by a `tool-result` block inside a user turn.
        messages.push(createToolResultMessage({
          callId: callId(call),
          content: [{ type: 'text', text: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '') }],
          isError: item.is_error === true,
        }))
        continue
      }
      const role = item.role === 'assistant' ? 'assistant' : 'user'
      const content = Array.isArray(item.content) ? item.content : [{ type: 'input_text', text: String(item.content ?? '') }]
      const blocks: ContentBlock[] = content.flatMap((part) => {
        const record = part as Record<string, unknown>
        const text = record.text ?? record.output_text
        return typeof text === 'string' ? [{ type: 'text' as const, text }] : []
      })
      if (blocks.length > 0) {
        messages.push(role === 'assistant'
          ? createAssistantMessage({ content: blocks, source: { provider: 'bridge', model: 'bridge' } })
          : createUserMessage({ content: blocks, source: { kind: 'user' } }))
      }
    }
  }
  const tools = Array.isArray(body.tools) ? body.tools.flatMap((value) => {
    const item = value as Record<string, unknown>
    const fn = (item.function ?? item) as Record<string, unknown>
    return typeof fn.name === 'string' ? [{ name: fn.name, description: String(fn.description ?? ''), parameters: (fn.parameters ?? {}) as Record<string, unknown> }] : []
  }) : undefined
  return {
    provider: route.provider,
    model: route.model,
    messages,
    ...(tools === undefined ? {} : { tools }),
    ...(typeof body.max_output_tokens === 'number' ? { maxTokens: body.max_output_tokens } : {}),
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }),
  }
}

const BRIDGE_IMAGE_PLACEHOLDER = '[image attachment: not forwarded by the FreeCodeGo bridge]'

function anthropicMessages(value: unknown): Message[] {
  const item = value as Record<string, unknown>
  const role = item.role === 'assistant' ? 'assistant' : 'user'
  const content = Array.isArray(item.content) ? item.content : [{ type: 'text', text: String(item.content ?? '') }]
  const messages: Message[] = []
  const blocks: ContentBlock[] = []
  /** Commit the blocks gathered since the last result as one turn. */
  const flushTurn = (): void => {
    if (blocks.length === 0) return
    messages.push(role === 'assistant'
      ? createAssistantMessage({ content: blocks.splice(0), source: { provider: 'bridge', model: 'bridge' } })
      : createUserMessage({ content: blocks.splice(0), source: { kind: 'user' } }))
  }
  for (const block of content) {
    const part = block as Record<string, unknown>
    // Anthropic carries tool results inside a user turn; the harness carries one
    // result per tool-role message. A client that batches several results into
    // one user turn (the common shape) therefore becomes several messages here,
    // and any text sharing that turn stays a turn of its own.
    if (part.type === 'tool_result') {
      flushTurn()
      messages.push(createToolResultMessage({
        callId: callId(String(part.tool_use_id ?? 'tool')),
        content: [{ type: 'text', text: toolResultText(part.content) }],
        isError: part.is_error === true,
      }))
      continue
    }
    if (part.type === 'text') { blocks.push({ type: 'text', text: String(part.text ?? '') }); continue }
    if (part.type === 'tool_use') { blocks.push({ type: 'tool-call', id: callId(String(part.id ?? randomUUID())), name: String(part.name ?? 'tool'), arguments: JSON.stringify(part.input ?? {}) }); continue }
    if (part.type === 'image') { blocks.push({ type: 'text', text: BRIDGE_IMAGE_PLACEHOLDER }); continue }
    // `thinking` and anything else (including a malformed part) maps to nothing.
  }
  flushTurn()
  // A history message whose blocks all mapped to nothing (thinking-only
  // assistant turns) contributes no message at all, rather than an empty turn
  // some providers reject.
  return messages
}

/** Flatten Anthropic tool_result content (string or block array) to plain text. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((block) => {
      const part = block as Record<string, unknown>
      if (part.type === 'text' && typeof part.text === 'string') return part.text
      if (part.type === 'image') return BRIDGE_IMAGE_PLACEHOLDER
      return JSON.stringify(part)
    }).filter(text => text !== '').join('\n')
  }
  return JSON.stringify(content ?? '')
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> { const chunks: StreamChunk[] = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
function isBridgeReasoningEffort(value: unknown): value is BridgeReasoningEffort { return value === 'off' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max' }

type AccumulatedToolCall = { id: string; name: string; args: string }

/** Merge streamed tool-call fragments into one entry per call index; fragments share the index and split id/name/arguments across deltas. */
function accumulateToolCalls(chunks: readonly StreamChunk[]): AccumulatedToolCall[] {
  const calls = new Map<number, AccumulatedToolCall>()
  for (const chunk of chunks) {
    if (chunk.type !== 'tool-call-delta') continue
    const call = calls.get(chunk.index) ?? { id: '', name: 'tool', args: '' }
    if (chunk.id !== '') call.id = chunk.id
    if (chunk.name !== undefined) call.name = chunk.name
    call.args += chunk.argumentsDelta
    calls.set(chunk.index, call)
  }
  return [...calls.values()]
}

function toNonStreamingResponse(chunks: readonly StreamChunk[], model: string): Record<string, unknown> {
  const text = chunks.filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  const thinking = chunks.filter((chunk): chunk is Extract<StreamChunk, { type: 'reasoning-delta' }> => chunk.type === 'reasoning-delta').map(chunk => chunk.text).join('')
  const blocks: Record<string, unknown>[] = []
  if (thinking !== '') blocks.push({ type: 'thinking', thinking, signature: '' })
  blocks.push({ type: 'text', text })
  for (const call of accumulateToolCalls(chunks)) {
    blocks.push({ type: 'tool_use', id: call.id !== '' ? call.id : `tool_${randomUUID()}`, name: call.name, input: parseArguments(call.args) })
  }
  const finish = chunks.find((chunk): chunk is Extract<StreamChunk, { type: 'finish' }> => chunk.type === 'finish')
  const usage = chunks.find((chunk): chunk is Extract<StreamChunk, { type: 'usage' }> => chunk.type === 'usage')?.usage
  const stopReason = finish?.reason.kind === 'tool-calls' ? 'tool_use' : finish?.reason.kind === 'max-tokens' ? 'max_tokens' : finish?.reason.kind === 'error' ? 'stop_sequence' : 'end_turn'
  return { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model, content: blocks, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: usage?.inputTokens ?? 0, output_tokens: usage?.outputTokens ?? 0 } }
}

/** Non-streaming /responses payload: message item plus one function_call item per tool call. */
function toResponsesObject(chunks: readonly StreamChunk[], model: string): Record<string, unknown> {
  const text = chunks.filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  const output: Record<string, unknown>[] = [{ id: `msg_${randomUUID()}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text }] }]
  let hasCalls = false
  for (const call of accumulateToolCalls(chunks)) {
    hasCalls = true
    output.push({ id: `fc_${randomUUID()}`, type: 'function_call', status: 'completed', call_id: call.id !== '' ? call.id : `call_${randomUUID()}`, name: call.name, arguments: call.args })
  }
  const finish = chunks.find((chunk): chunk is Extract<StreamChunk, { type: 'finish' }> => chunk.type === 'finish')
  const usage = chunks.find((chunk): chunk is Extract<StreamChunk, { type: 'usage' }> => chunk.type === 'usage')?.usage
  return { id: `resp_${randomUUID()}`, object: 'response', created_at: new Date().toISOString(), status: hasCalls || finish?.reason.kind !== 'error' ? 'completed' : 'failed', model, output, usage: { input_tokens: usage?.inputTokens ?? 0, output_tokens: usage?.outputTokens ?? 0, total_tokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) } }
}

function parseArguments(value: string): Record<string, unknown> { try { return JSON.parse(value) as Record<string, unknown> } catch { return {} } }
function writeEvent(writer: StreamWriter, event: string, data: unknown): void { writer.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
function writeData(writer: StreamWriter, data: unknown): void { writer.write(`data: ${JSON.stringify(data)}\n\n`) }
function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > maxBytes) { req.destroy(); reject(new Error('bridge request body exceeds the size limit')); return }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', reject)
  })
}
