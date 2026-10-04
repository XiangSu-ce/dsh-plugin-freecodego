/** Lightweight OpenAI-compatible streaming adapter owned by FreeCodeGo. */

import { attributionHeaders, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk, ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import type {
  AttachmentStore, ImageAttachmentRef, ImageRequestTarget, RequestImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { hasImageContent, serializeRequest, serializeRequestWithInlineImages, translate } from './openai-wire.ts'
import { parseSse } from './wire-shared.ts'
import { StreamIdleTimeoutError, withIdleDeadline } from './stream-deadline.ts'
import { redactCredentialShapes } from './secret-scan.ts'
import { llmCodeForUpstreamStatus } from './upstream-status-code.ts'
import { ANTHROPIC_MESSAGES_HEADERS, serializeAnthropicRequest, serializeAnthropicRequestWithInlineImages, translateAnthropic } from './anthropic-wire.ts'

/**
 * The request dialects this transport can actually put on the wire.
 *
 * `openai` is a chat-completions body at `/chat/completions`; `anthropic` is a
 * Messages body at `/messages`. There is no third body shape here, so a backend
 * protocol that does not fold onto one of these two is a route this adapter
 * cannot serve.
 */
export type OpenAiCompatibleWire = 'openai' | 'anthropic'

/**
 * The one place a backend protocol spelling becomes a wire.
 *
 * The catalog labels a group with the dialect its *upstream channel* speaks, not
 * with the body the client must send: the group is picked by the
 * `X-FreeCodeGo-Route-Key` header, and the route key already carries the
 * protocol (`model:openai_responses:gpt-5.6`). The backend folds both OpenAI
 * dialects into one public text route family, which is why `openai_responses`
 * and `openai_chat_completions` share the chat-completions wire — the Responses
 * *body* shape (`input` instead of `messages`, `response.output_text.delta`
 * instead of `choices[].delta`) is a different contract, and the only place this
 * plugin speaks it is the image-generation tool call on `/responses`
 * (`media-generation.ts`), which the media route chooses, not this label.
 *
 * A single named mapping rather than a list of accepted spellings: the router's
 * accepted set is derived from these keys, so a protocol string can never be
 * routed without a wire behind it, and the transport reads the same entry when
 * it decides which body to serialize.
 */
export const WIRE_FOR_PROTOCOL: ReadonlyMap<string, OpenAiCompatibleWire> = new Map<string, OpenAiCompatibleWire>([
  ['openai_responses', 'openai'],
  ['openai_chat_completions', 'openai'],
  ['anthropic', 'anthropic'],
])

/** Protocols a route may accept; derived so it cannot name an unsendable wire. */
export const SUPPORTED_WIRE_PROTOCOLS: readonly string[] = [...WIRE_FOR_PROTOCOL.keys()]

/** Fold the backend's protocol spellings so they can be compared.
 * @param protocol - the backend's declared protocol spelling.
 * @returns the canonical protocol key.
 */
export function normalizeWireProtocol(protocol: string | undefined): string {
  const value = (protocol ?? '').trim().toLowerCase().replace(/-/gu, '_')
  if (value === 'openai' || value === 'responses') return 'openai_responses'
  if (value === 'chat' || value === 'chat_completions') return 'openai_chat_completions'
  return value
}

/** The wire that serves a backend protocol, or `undefined` when none does.
 * @param protocol - the backend's declared protocol spelling.
 * @returns the wire serving that protocol, or `undefined` when unsupported.
 */
export function wireForProtocol(protocol: string | undefined): OpenAiCompatibleWire | undefined {
  return WIRE_FOR_PROTOCOL.get(normalizeWireProtocol(protocol))
}

/**
 * Default idle deadline for one provider request, in milliseconds.
 *
 * Replaces what used to be a 120-second *total* request budget. An absolute
 * budget cannot be used on a streamed completion: a reasoning turn that takes
 * minutes is not a failure, and aborting it made the Harness re-send the
 * identical request — which on a slow route never got any further than the
 * aborted one did, so the turn could not finish at all. Silence is the only
 * evidence that something is wrong, so the deadline is refreshed by every chunk
 * (`withIdleDeadline`, the same decision the provider bridge makes) and the wait
 * for the response headers gets a deadline of its own, because that one silence
 * no chunk can break.
 */
export const PROVIDER_STREAM_IDLE_MS = 120_000

/** How one OpenAI-compatible route reaches its provider. */
export interface OpenAiCompatibleConnection {
  readonly baseURL: string
  readonly apiKey: string
  readonly endpointPath?: string
  readonly headers?: Readonly<Record<string, string>>
  /** Wire-model override for catalog aliases such as `openrouter/<model>`. */
  readonly model?: string
  /**
   * Request dialect. `openai` (default) sends a chat-completions body to
   * `/chat/completions`; `anthropic` sends a Messages body to `/messages`.
   * Resolve it through {@link wireForProtocol} so a route's declared protocol
   * and the body it is sent cannot disagree.
   */
  readonly wire?: OpenAiCompatibleWire
}

/** The DeepSeek-compatible serializer accepts only these wire effort values. */
export type SupportedReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** How one OpenAI-compatible adapter is wired to its provider. */
export interface OpenAiCompatibleAdapterOptions {
  readonly providerName: string
  readonly listModels: (provider: string) => Promise<readonly LlmModelInfo[]>
  readonly resolveConnection: (model: string, signal?: AbortSignal) => Promise<OpenAiCompatibleConnection>
  /**
   * Tool names the provider's free tier requires on every request that already
   * carries tools. Missing ones are appended as minimal definitions, so a
   * caller whose tool set is narrower than the provider's fingerprint — a
   * Plan Mode turn, a subagent scope, or any agent whose deferred/denied
   * names exclude one of the five — is still served.
   *
   * A request that declares no tools at all is left untouched: it is not agent
   * traffic, and inventing tools for it would offer a model a capability its
   * caller never granted. See {@link withRequiredAgentTools}.
   */
  readonly requireAgentTools?: readonly string[]
  /** Reject selection before it can become the Session's next route. */
  readonly assertSelectable?: (model: string) => Promise<void>
  /** Metadata discovery may resolve unconfigured models to render disabled rows. */
  readonly assertSelectableOnResolve?: boolean
  /** Maps provider-specific effort labels to the official OpenAI-compatible vocabulary. */
  readonly normalizeReasoningEffort?: (effort: string | undefined) => SupportedReasoningEffort | undefined
  /** Selects the request dialect. The gateway uses `thinking`; direct OpenAI-compatible providers use `reasoning_effort`. */
  readonly reasoningWire?: 'gateway' | 'standard'
  /**
   * Drop the `stream_options.include_usage` envelope from every request.
   *
   * The envelope is what makes a provider report its token counts, and a turn
   * whose provider reported nothing reaches the token ledger as an attempt with
   * every bucket at zero — the route then reads as permanently unused no matter
   * how much traffic it serves. So this is an escape hatch for an endpoint whose
   * refusal is already known, not a per-provider preference: the adapter detects
   * that refusal itself and retries the request without the envelope, which is
   * why a working provider must not be opted out of it by hand.
   */
  readonly includeUsage?: boolean
  /** Default shown in the picker when this route supports optional reasoning. */
  readonly defaultReasoningEffort?: SupportedReasoningEffort
  /** Model-specific subset retained after real provider capability checks. */
  /** `undefined` disables reasoning for that exact model. */
  readonly reasoningEffortsForModel?: (model: string) => readonly SupportedReasoningEffort[] | undefined
  /** Called only when an upstream rejects a selected reasoning parameter. */
  readonly onReasoningRejected?: (model: string, effort: Exclude<SupportedReasoningEffort, 'off'>) => void
  /**
   * Called when an upstream answers HTTP 429 so the provider can surface a
   * user-facing suggestion (e.g. “disable your proxy / retry from a real IP”)
   * in addition to the raw `RATE_LIMIT` LlmError.
   */
  readonly onRateLimited?: (provider: string, status: number) => void
  /**
   * Extra user-facing hint (bilingual) appended to the thrown non-2xx
   * `LlmError` so the raw HTTP status is never the only thing the UI can show.
   *
   * The provider decides which statuses it can explain, because the same number
   * means different things on different routes: a `429` is a rate limit
   * everywhere, while a `403` is only worth explaining when the body says which
   * gate was hit — OpenCode's free tier answers `403` with `FreeTierError` when
   * it will not serve the request from this egress.
   * @param provider - the provider name this adapter reports.
   * @param status - the HTTP status the upstream answered with.
   * @param detail - the redacted response body.
   * @returns the hint to append, or `undefined` when this status needs none.
   */
  readonly rateLimitedHint?: (provider: string, status: number, detail: string) => string | undefined
  readonly defaultContextWindow?: number
  readonly defaultMaxTokens?: number
  /** Let the provider choose its own default output budget when true. */
  readonly omitDefaultMaxTokens?: boolean
  /** Do not send max_tokens, including values supplied by an older session. */
  readonly omitMaxTokens?: boolean
  /** Hard upper bound applied to every request, including explicit overrides. */
  readonly maxOutputTokens?: number
  /** Resolves durable browser image attachments only for explicitly visual models. */
  readonly resolveAttachments?: () => AttachmentStore | undefined
  /** Per-route request-image normalization budget before base64 expansion. */
  readonly imageRequestPolicy?: FreeCodeGoImageRequestBudget
  /**
   * How long the route may go quiet before its stream is treated as stalled.
   *
   * Idle rather than absolute: the deadline is refreshed by every chunk, so a
   * slow-but-alive answer is never cut off for taking a long time. It also
   * bounds the wait for the response headers, which is the one silence no chunk
   * can break. Defaults to {@link PROVIDER_STREAM_IDLE_MS}.
   */
  readonly streamIdleMs?: number
}

/**
 * A catalog row with the extra facts a route's own metadata may carry.
 *
 * Not decorative: `LlmModelInfo` does not declare these fields, so the assertion
 * that reads them is what makes them visible, and removing it is what makes the
 * adapter stop compiling.
 */
type ModelLimits = LlmModelInfo & {
  readonly contextWindow?: number
  readonly maxTokens?: number
  readonly availability?: string
}

/**
 * Plugin-local adapter for routes where connection facts are Host-owned and
 * can change on every request. Visual routes encode normalized attachments as
 * OpenAI-compatible image data URLs; text routes retain explicit rejection.
 */
export class OpenAiCompatibleAdapter extends LlmAdapter {
  constructor(private readonly config: OpenAiCompatibleAdapterOptions) {
    super()
  }

  /** The idle deadline this route applies to its streams, headers included. */
  private get streamIdleMs(): number {
    return this.config.streamIdleMs ?? PROVIDER_STREAM_IDLE_MS
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.config.providerName }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.config.listModels(provider)
  }

  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const known = (await this.config.listModels(provider)).find(candidate => candidate.id === model) as ModelLimits | undefined
    // Catalog construction resolves every advertised row, including rows that
    // are intentionally disabled because a credential is missing or an
    // upstream is degraded. Do not reject those metadata lookups; enforce the
    // provider's selectability check for routable rows and explicit unknown
    // requests instead.
    if (this.config.assertSelectableOnResolve !== false && known?.availability !== 'unavailable') await this.config.assertSelectable?.(model)
    const effort = this.config.normalizeReasoningEffort
    const configuredReasoning = this.config.reasoningEffortsForModel?.(model)
    const reasoningEnabled = effort !== undefined && (this.config.reasoningEffortsForModel === undefined || configuredReasoning !== undefined)
    const reasoningEfforts = configuredReasoning ?? ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const
    const defaultEffort = defaultReasoningEffort(reasoningEfforts, this.config.defaultReasoningEffort ?? effort?.(undefined))
    return {
      provider,
      id: model,
      name: known?.name ?? model,
      ...(known?.description === undefined ? {} : { description: known.description }),
      // Modality metadata is advisory for these gateway routes. Preserve image
      // blocks and let the selected upstream model accept or reject them.
      inputModalities: ['text', 'image'] as const,
      context: { contextWindow: known?.contextWindow ?? this.config.defaultContextWindow ?? 1_000_000 },
      ...this.config.omitDefaultMaxTokens === true
        ? {}
        : { defaultMaxTokens: known?.maxTokens ?? this.config.defaultMaxTokens ?? 256_000 },
      ...!reasoningEnabled ? {} : {
        reasoning: {
          efforts: [
            ...reasoningEfforts.map(value => ({
              id: ReasoningEffortId(value),
              name: value.slice(0, 1).toUpperCase() + value.slice(1),
            })),
          ],
          defaultEffort: ReasoningEffortId(defaultEffort),
        },
      },
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = await this.config.resolveConnection(options.model, options.signal)
    if (connection.wire === 'anthropic') {
      yield* this.streamAnthropic(options, connection)
      return
    }
    const configuredReasoning = this.config.reasoningEffortsForModel?.(options.model)
    const reasoningEnabled = this.config.reasoningEffortsForModel === undefined || configuredReasoning !== undefined
    const configuredEfforts = configuredReasoning ?? ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const
    const selectedEffort = options.reasoningEffort ?? (reasoningEnabled
      ? defaultReasoningEffort(configuredEfforts, this.config.defaultReasoningEffort ?? this.config.normalizeReasoningEffort?.(undefined))
      : undefined)
    const normalizedEffort = reasoningEnabled ? this.config.normalizeReasoningEffort?.(selectedEffort) : undefined
    const {
      reasoningEffort: _discardedReasoningEffort,
      maxTokens: requestedMaxTokens,
      ...withoutReasoning
    } = options
    const maxOutputTokens = this.config.omitMaxTokens === true
      ? undefined
      : clampMaxOutputTokens(requestedMaxTokens, this.config.maxOutputTokens)
    const request = {
      ...withoutReasoning,
      model: connection.model ?? options.model,
      ...(maxOutputTokens === undefined ? {} : { maxTokens: maxOutputTokens }),
      ...(this.config.reasoningWire === 'standard'
        ? normalizedEffort === undefined || normalizedEffort === 'off' ? {} : { reasoningEffort: ReasoningEffortId(normalizedEffort) }
        : normalizedEffort === undefined || normalizedEffort === 'off'
          ? { reasoningEffort: ReasoningEffortId('off') }
          : { reasoningEffort: ReasoningEffortId(normalizedEffort) }),
    }
    const defaults = { ...(this.config.reasoningWire === undefined ? {} : { reasoningWire: this.config.reasoningWire }), ...(this.config.includeUsage === false ? { includeUsage: false } : {}) }
    const serialized = await this.serialize(request, defaults)
    const body = this.config.requireAgentTools === undefined
      ? serialized
      : withRequiredAgentTools(serialized, options.tools, this.config.requireAgentTools)
    const endpoint = `${connection.baseURL.replace(/\/+$/, '')}${connection.endpointPath ?? '/chat/completions'}`
    const response = await this.postToleratingUsageRefusal(endpoint, { authorization: `Bearer ${connection.apiKey}`, ...connection.headers }, body, options, (detail) => {
      if (normalizedEffort !== undefined && normalizedEffort !== 'off' && isRejectedReasoningParameter(detail)) {
        this.config.onReasoningRejected?.(options.model, normalizedEffort)
      }
    })
    if (response.body === null) throw new LlmError(`${this.config.providerName} returned no response body`, 'EMPTY_RESPONSE')
    try {
      yield* withIdleDeadline(translate(parseSse(response.body)), this.streamIdleMs)
    } catch (error) {
      throw this.streamFailure(error, options)
    }
  }

  /**
   * Name a failed stream so the caller knows which of the two silences it hit.
   *
   * A cancellation comes from the client and must stay quiet; a provider that
   * stopped answering is a transport failure the turn is allowed to retry. The
   * classification is shared with the provider bridge, which keys on the same
   * {@link StreamIdleTimeoutError}, so both routes report one stall one way.
   * @param error - the failure the stream raised.
   * @param options - the request, for its cancellation signal.
   * @returns the failure to throw.
   */
  private streamFailure(error: unknown, options: GenerateOptions): LlmError {
    if (options.signal?.aborted) return new LlmError(`${this.config.providerName} request aborted by caller`, 'ABORTED', { cause: error })
    if (error instanceof LlmError) return error
    if (error instanceof StreamIdleTimeoutError) return new LlmError(`${this.config.providerName} stream stalled`, 'TIMEOUT', { cause: error })
    return new LlmError(`${this.config.providerName} stream failed`, 'TRANSPORT', { cause: error })
  }

  /**
   * POST a body, retrying once without the usage envelope if the endpoint
   * refuses that optional extension.
   *
   * Sending the envelope is a correctness requirement rather than a preference:
   * without `stream_options.include_usage` a provider reports no token counts at
   * all, and an attempt whose provider said nothing is recorded with every
   * bucket at zero — so the route appears in the token panel as never used while
   * the user is paying for it. Some endpoints answer `400` to the extension
   * anyway, and that refusal is a body-shape answer that arrived before any
   * generation: the same request without the field is retried so such a provider
   * keeps working, and the missing usage is then its own limitation rather than
   * a silent local choice.
   *
   * The refusal has to name the field to qualify. A `400` about anything else is
   * surfaced unchanged: retrying it would send a request the upstream had
   * already rejected on purpose.
   * @param endpoint - the absolute completion endpoint.
   * @param headers - request headers, already carrying the route's authorization.
   * @param body - the serialized request body, envelope included unless opted out.
   * @param options - the caller's request, for its cancellation signal.
   * @param onBadRequest - the provider's own hook for a `400` it can explain.
   * @returns the accepted response.
   */
  private async postToleratingUsageRefusal(
    endpoint: string,
    headers: Readonly<Record<string, string>>,
    body: Record<string, unknown>,
    options: GenerateOptions,
    onBadRequest?: (detail: string) => void,
  ): Promise<Response> {
    try {
      return await this.post(endpoint, headers, body, options, onBadRequest)
    } catch (error) {
      // Only a body that actually carried the envelope has one to drop, so an
      // opted-out route cannot be sent twice here.
      if (!('stream_options' in body) || !refusesUsageEnvelope(error)) throw error
      const { stream_options: _refusedEnvelope, ...withoutUsageEnvelope } = body
      return await this.post(endpoint, headers, withoutUsageEnvelope, options, onBadRequest)
    }
  }

  /** POST a JSON body and convert transport/HTTP failures to LlmError. */
  private async post(
    endpoint: string,
    headers: Readonly<Record<string, string>>,
    body: Record<string, unknown>,
    options: GenerateOptions,
    onBadRequest?: (detail: string) => void,
  ): Promise<Response> {
    let response: Response
    // Only the *wait for the response* is bounded here, and only until the
    // headers arrive: the stream that follows carries its own idle deadline, so
    // a long but live answer is never cut off for taking a long time. What this
    // still catches is the provider that accepts the connection and then answers
    // nothing at all — the one case no chunk-based deadline can see.
    const headersDeadline = new AbortController()
    const headersTimer = setTimeout(() => {
      headersDeadline.abort(new StreamIdleTimeoutError(this.streamIdleMs))
    }, this.streamIdleMs)
    // A pending deadline must not hold the Host open on its own.
    ;(headersTimer as { unref?: () => void }).unref?.()
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          ...attributionHeaders(),
          accept: 'text/event-stream',
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
        // A caller's cancellation and the provider's own deadline are
        // independent: supplying the former must not let a half-open TCP
        // connection hang the turn forever.
        signal: options.signal === undefined
          ? headersDeadline.signal
          : AbortSignal.any([options.signal, headersDeadline.signal]),
      })
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError(`${this.config.providerName} request aborted by caller`, 'ABORTED', { cause: error })
      if (headersDeadline.signal.aborted) throw new LlmError(`${this.config.providerName} request timed out`, 'TIMEOUT', { cause: error })
      throw new LlmError(`${this.config.providerName} request failed`, 'TRANSPORT', { cause: error })
    } finally {
      // The headers are in (or the request is over), so the wait is no longer
      // what needs watching — the stream is.
      clearTimeout(headersTimer)
    }
    if (!response.ok) {
      const detail = redactProviderDetail(await response.text().catch(() => ''))
      if (response.status === 400) onBadRequest?.(detail)
      if (response.status === 429) this.config.onRateLimited?.(this.config.providerName, response.status)
      // The bare status is useless to the operator: append the provider-configured
      // bilingual suggestion whenever that provider has one for this status — a 429
      // rate limit, or the gate a free tier answers a 403 with.
      const rateHint = this.config.rateLimitedHint?.(this.config.providerName, response.status, detail)
      // The code is the shared status policy, not a local ladder. It used to read
      // `401 || 403 ? 'AUTH'`, which reported the plan gate on a paid route as a
      // rejected key: the UI asked the user to sign in again over a working
      // credential, and the failure ledger counted an `AUTH` that never happened.
      // `403` is a gate on *this* route, and only `401` says the sign-in is dead.
      throw new LlmError(
        `${this.config.providerName} provider request failed (HTTP ${response.status})${detail === '' ? '' : `: ${detail}`}${rateHint === undefined ? '' : `\n${rateHint}`}`,
        llmCodeForUpstreamStatus(response.status),
        { status: response.status },
      )
    }
    return response
  }

  /**
   * Anthropic Messages streaming path (gateway `/v1/messages` route).
   *
   * The body names the connection's wire model, not the selection value, for the
   * same reason the chat-completions path does: a group-pinned selection
   * (`id@group:N`) names a backend group, the pin travels in the route key, and
   * the wire body has to carry the bare id. Sending the pin put a model name the
   * backend's account mappings never contain into the request, so every pinned
   * Anthropic row — which is every backend Claude group — answered `503 No
   * available accounts`, while its OpenAI sibling on the same picker worked
   * because that path applied the override.
   * @param options - the caller's request, whose `model` is the selection value.
   * @param connection - the resolved route, whose `model` is the wire model.
   */
  private async *streamAnthropic(options: GenerateOptions, connection: OpenAiCompatibleConnection): AsyncIterable<StreamChunk> {
    const wireOptions = connection.model === undefined || connection.model === options.model
      ? options
      : { ...options, model: connection.model }
    const attachments = hasImageContent(wireOptions) ? this.config.resolveAttachments?.() : undefined
    const body = attachments === undefined
      ? await serializeAnthropicRequest(wireOptions)
      : await serializeAnthropicRequestWithInlineImages(wireOptions, {
        resolveImage: ref => attachments.readImageRequest(ref, imageRequestTarget(ref, this.config.imageRequestPolicy), wireOptions.signal),
      })
    const endpoint = `${connection.baseURL.replace(/\/+$/, '')}${connection.endpointPath ?? '/messages'}`
    const response = await this.post(
      endpoint,
      // Anthropic authenticates with `x-api-key` rather than a bearer token.
      { 'x-api-key': connection.apiKey, ...ANTHROPIC_MESSAGES_HEADERS, ...connection.headers },
      body,
      options,
    )
    if (response.body === null) throw new LlmError(`${this.config.providerName} returned no response body`, 'EMPTY_RESPONSE')
    try {
      yield* withIdleDeadline(translateAnthropic(parseSse(response.body)), this.streamIdleMs)
    } catch (error) {
      throw this.streamFailure(error, options)
    }
  }

  private async serialize(
    options: GenerateOptions,
    defaults: { readonly reasoningWire?: 'gateway' | 'standard'; readonly includeUsage?: boolean },
  ): Promise<Record<string, unknown>> {
    if (!hasImageContent(options)) return serializeRequest(options, defaults)
    const attachments = this.config.resolveAttachments?.()
    // A historical generated image may be nested inside a tool result. It is
    // intentionally handled by the text serializer as an attachment
    // placeholder; only direct user image blocks require the attachment
    // service and inline visual serialization.
    if (attachments === undefined) return serializeRequest(options, defaults)
    return serializeRequestWithInlineImages(options, {
      resolveImage: async (ref: ImageAttachmentRef): Promise<RequestImageAttachment> => (
        attachments.readImageRequest(ref, imageRequestTarget(ref, this.config.imageRequestPolicy), options.signal)
      ),
    }, defaults)
  }
}

/**
 * Whether an upstream refused the optional `stream_options` usage envelope.
 *
 * Both halves are required. `400` is the status a body-shape refusal uses, so
 * another status is a different failure; and the provider's own words have to
 * name the field, because a `400` that means something else is a real request
 * error that must reach the caller instead of being retried.
 * @param error - the failure the POST raised.
 * @returns whether dropping the envelope and retrying is the right response.
 */
function refusesUsageEnvelope(error: unknown): boolean {
  if (!(error instanceof LlmError) || error.failure.status !== 400) return false
  return /stream[_-]?options|include[_-]?usage/iu.test(error.message)
}

/**
 * Harness 0.1.6 replaced the attachment service's `ImageRequestPolicy` with an
 * `ImageRequestTarget` of explicit width, height, and byte budget, so the pixel
 * ceiling is projected onto each source's geometry here — the construction
 * `@deepseek-ai/dsh-llm-pi-ai` uses for its own per-route budget.
 */
export interface FreeCodeGoImageRequestBudget {
  /** Total-pixel ceiling the request projection must fit. */
  readonly maxPixels: number
  /** Encoded-byte target before base64 expansion. */
  readonly maxBytes: number
}

const DEFAULT_IMAGE_REQUEST_BUDGET: FreeCodeGoImageRequestBudget = {
  maxPixels: 6_000_000,
  maxBytes: 10 * 1024 * 1024,
}

function imageRequestTarget(
  ref: Pick<ImageAttachmentRef, 'width' | 'height'>,
  budget: FreeCodeGoImageRequestBudget | undefined,
): ImageRequestTarget {
  const resolved = budget ?? DEFAULT_IMAGE_REQUEST_BUDGET
  return { ...requestImageDimensions(ref.width, ref.height, resolved.maxPixels), maxBytes: resolved.maxBytes }
}

/**
 * Whether a request carries fresh user-supplied image input.
 *
 * Re-exported because the capability evaluation scores this decision: that
 * suite is only worth its point while the function it measures is the one the
 * wire path actually calls. The rule itself lives beside the serializer that
 * acts on it, shared with the Agnes route, which carried a second copy.
 */
export { hasImageContent }

/** Clamp an explicit output budget to the route's ceiling; a meaningless limit
 * (zero, negative, non-finite) leaves the request's own value alone.
 *
 * @param value - the budget the caller asked for, if any.
 * @param limit - the route's hard ceiling, if it declares one.
 * @returns the budget to send, or `undefined` to send none.
 */
export function clampMaxOutputTokens(value: number | undefined, limit: number | undefined): number | undefined {
  if (value === undefined || limit === undefined || !Number.isFinite(limit) || limit <= 0) return value
  return Math.min(value, Math.floor(limit))
}

/** The effort a request runs at when the caller named none: its preferred level
 * while the route supports it, else `high`, else the route's first level.
 *
 * @param efforts - the levels this route declares, in its own order.
 * @param preferred - the level the caller (or config) would prefer.
 * @returns one of `efforts`, never a level the route did not declare.
 */
export function defaultReasoningEffort(
  efforts: readonly SupportedReasoningEffort[],
  preferred: SupportedReasoningEffort | undefined,
): SupportedReasoningEffort {
  if (preferred !== undefined && efforts.includes(preferred)) return preferred
  return efforts.includes('high') ? 'high' : efforts[0] ?? 'off'
}

/** Whether an upstream 400 blames the reasoning parameter, so the adapter may
 * report a rejection instead of failing the turn.
 *
 * @param detail - the redacted upstream error body.
 * @returns true when the rejection is about the reasoning parameter.
 */
export function isRejectedReasoningParameter(detail: string): boolean {
  return /reasoning(?:_effort| effort)|thinking/i.test(detail)
    && /unsupported|not supported|invalid|unknown|allowed|parameter/i.test(detail)
}

/** Strip credentials from an upstream error body before it reaches the session
 * log or the UI. The name is explicit because it is imported by the capability
 * evaluation, which must redact through this same function.
 *
 * @param value - the raw upstream text.
 * @returns the same text with credential shapes replaced and newlines folded.
 */
export function redactProviderDetail(value: string): string {
  // Curated shapes first: a provider that echoes a key it rejected sends it back in
  // whichever shape the key has, and this chain only knew bearer, keyword and `sk-`.
  return redactCredentialShapes(value)
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer <redacted>')
    // Providers echo credentials in more shapes than one: query params, JSON
    // fields, and bare `sk-` strings all leak through a Bearer-only pattern.
    .replace(/(?:^|[\s"'=&?])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token)(?:["'=:\s]+)[a-z0-9._~+/=-]{8,}/gi, '$1<redacted>')      .replace(/\bsk-[A-Za-z0-9._-]{16,}\b/g, 'sk-<redacted>')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 1_024)
}

/**
 * Append minimal definitions for any of `names` a chat-completions body does not
 * already declare, so the request reads as an agent session upstream.
 *
 * OpenCode's free tier refuses (`403 FreeTierError: OpenCode's free tier can
 * only be used from within OpenCode`) any request that does not look like one of
 * its own client's agent turns. Two of the three conditions are request
 * identity, carried by headers; the third is this one, and it is a body
 * condition: `bash`, `edit`, `glob`, `grep` and `read` must all appear in
 * `tools`. A caller whose own tool set is narrower — a Plan Mode turn, a
 * subagent scope, or any agent whose deferred/denied names exclude one of the
 * five — would otherwise be refused for a reason that has nothing to do with
 * what it asked for.
 *
 * The widening is deliberately one-sided. A body that declares *no* tools is
 * returned untouched rather than filled in: it is not agent traffic, and
 * synthesizing tools for it would offer the model a capability its caller never
 * granted. `memory-dream-model.ts` types `tools` as an empty tuple precisely so
 * that consolidation cannot call anything, and `prepareAnonymousBody` in the
 * reference gateway makes the same distinction from the other side.
 *
 * Whether an appended tool can actually *run* is the caller's question, not
 * this one: the Harness derives the wire schema from each agent's tool scope and
 * refuses a call outside it, so a definition added here buys the request a
 * shape, not a permission.
 *
 * @param body - the serialized chat-completions body.
 * @param tools - the tools the caller declared, if any.
 * @param names - the tool names the provider requires on an agent-shaped body.
 * @returns the body, with the missing definitions appended; the same object when
 *   the caller declared no tools or already declared every required name.
 */
function withRequiredAgentTools(
  body: Record<string, unknown>,
  tools: readonly ToolSchema[] | undefined,
  names: readonly string[],
): Record<string, unknown> {
  if (tools === undefined || tools.length === 0) return body
  const declared = new Set(tools.map(tool => tool.name))
  const missing = names.filter(name => !declared.has(name))
  if (missing.length === 0) return body
  const existing = Array.isArray(body.tools) ? body.tools : []
  return {
    ...body,
    tools: [
      ...existing,
      ...missing.map(name => ({
        type: 'function',
        function: { name, description: `Agent tool ${name}`, parameters: { type: 'object', properties: {} } },
      })),
    ],
  }
}
