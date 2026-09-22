/** Lightweight OpenAI-compatible streaming adapter owned by FreeCodeGo. */

import { attributionHeaders, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import type {
  AttachmentStore, ImageAttachmentRef, ImageRequestTarget, RequestImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { hasImageContent, serializeRequest, serializeRequestWithInlineImages, translate } from './openai-wire.ts'
import { parseSse } from './wire-shared.ts'
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
  /** Reject selection before it can become the Session's next route. */
  readonly assertSelectable?: (model: string) => Promise<void>
  /** Metadata discovery may resolve unconfigured models to render disabled rows. */
  readonly assertSelectableOnResolve?: boolean
  /** Maps provider-specific effort labels to the official OpenAI-compatible vocabulary. */
  readonly normalizeReasoningEffort?: (effort: string | undefined) => SupportedReasoningEffort | undefined
  /** Selects the request dialect. The gateway uses `thinking`; direct OpenAI-compatible providers use `reasoning_effort`. */
  readonly reasoningWire?: 'gateway' | 'standard'
  /** Some OpenAI-compatible providers reject the optional stream usage envelope. */
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
   * Extra user-facing hint appended to the thrown `RATE_LIMIT` LlmError so
   * the raw HTTP status is never the only thing the UI can show.
   */
  readonly rateLimitedHint?: (provider: string) => string
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
    const body = await this.serialize(request, defaults)
    const endpoint = `${connection.baseURL.replace(/\/+$/, '')}${connection.endpointPath ?? '/chat/completions'}`
    const response = await this.post(endpoint, { authorization: `Bearer ${connection.apiKey}`, ...connection.headers }, body, options, (detail) => {
      if (normalizedEffort !== undefined && normalizedEffort !== 'off' && isRejectedReasoningParameter(detail)) {
        this.config.onReasoningRejected?.(options.model, normalizedEffort)
      }
    })
    if (response.body === null) throw new LlmError(`${this.config.providerName} returned no response body`, 'EMPTY_RESPONSE')
    try {
      yield* translate(parseSse(response.body))
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError(`${this.config.providerName} request aborted by caller`, 'ABORTED', { cause: error })
      if (error instanceof LlmError) throw error
      throw new LlmError(`${this.config.providerName} stream failed`, 'TRANSPORT', { cause: error })
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
        // A caller's cancellation and the provider deadline are independent:
        // supplying the former must not let a half-open TCP connection hang the
        // turn forever.
        signal: options.signal === undefined
          ? AbortSignal.timeout(120_000)
          : AbortSignal.any([options.signal, AbortSignal.timeout(120_000)]),
      })
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError(`${this.config.providerName} request aborted by caller`, 'ABORTED', { cause: error })
      throw new LlmError(`${this.config.providerName} request failed`, 'TRANSPORT', { cause: error })
    }
    if (!response.ok) {
      const detail = redactProviderDetail(await response.text().catch(() => ''))
      if (response.status === 400) onBadRequest?.(detail)
      if (response.status === 429) this.config.onRateLimited?.(this.config.providerName, response.status)
      // The bare status is useless to the operator on a 429: append the
      // provider-configured proxy/IP suggestion (bilingual) when present.
      const rateHint = response.status === 429 ? this.config.rateLimitedHint?.(this.config.providerName) : undefined
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

  /** Anthropic Messages streaming path (gateway `/v1/messages` route). */
  private async *streamAnthropic(options: GenerateOptions, connection: OpenAiCompatibleConnection): AsyncIterable<StreamChunk> {
    const attachments = hasImageContent(options) ? this.config.resolveAttachments?.() : undefined
    const body = attachments === undefined
      ? await serializeAnthropicRequest(options)
      : await serializeAnthropicRequestWithInlineImages(options, {
        resolveImage: ref => attachments.readImageRequest(ref, imageRequestTarget(ref, this.config.imageRequestPolicy), options.signal),
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
      yield* translateAnthropic(parseSse(response.body))
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError(`${this.config.providerName} request aborted by caller`, 'ABORTED', { cause: error })
      if (error instanceof LlmError) throw error
      throw new LlmError(`${this.config.providerName} stream failed`, 'TRANSPORT', { cause: error })
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
