/**
 * The local free-model route and its model directory.
 *
 * Why a loopback route rather than a protocol client
 * -------------------------------------------------
 * The network is peer-to-peer: a buyer discovers sellers on the DHT, opens an
 * end-to-end encrypted connection, and negotiates a zero-priced metered channel
 * against an on-chain FreeUsage contract before the first request. Even a free
 * request is EIP-712 signed. Reimplementing that here would mean owning a DHT,
 * a frame codec, connection auth, and a contract address table, against a
 * protocol whose schema version changed twice in the week this was written.
 *
 * The buyer runtime is therefore an external process (see `buyer-runtime.ts`),
 * and everything in this module treats it as one thing: an OpenAI-compatible
 * endpoint on loopback that the Harness can be pointed at. That is the same
 * seam the upstream desktop client uses when it patches other tools' provider
 * configuration, so the wire behaviour is theirs and stays theirs.
 *
 * Three facts this module owns
 * ----------------------------
 * The endpoint is **loopback only**. The runtime binds `127.0.0.1`, and the
 * base URL built here says `127.0.0.1` rather than `localhost`, because
 * `localhost` resolves to `::1` first on some Windows configurations and the
 * runtime's listener is IPv4.
 *
 * The API key is a **placeholder**. The local proxy accepts any non-empty
 * value, and this one is never a secret: it exists because an OpenAI-compatible
 * client refuses to send a request with an empty key.
 *
 * **"Free" is read from the prices, never from the absence of a price.** The
 * buyer's `/v1/models` answers with the *whole* network — every seller, every
 * model, paid or not — and each offer carries what that seller charges. What it
 * does *not* do is mark anything as free. The seller's own test is
 * `isZeroTokenPricing(price) && isFreeUnitBillingModel(unit)`
 * (`packages/node/src/seller-request-handler.ts`), which is why a priced unit
 * is read here as well as a priced token: on the live network every image model
 * advertises `inputUsdPerMillion: 0, outputUsdPerMillion: 0` and bills
 * `minImageUsdPerImage: 0.0045…0.13` per picture. Selecting one of those from a
 * list labelled "free" reaches a seller that answers `402 payment_required`.
 * See {@link AntSeedModelRow.free}.
 *
 * What the prices cannot decide
 * -----------------------------
 * The priced unit is only ever *partly* visible from here, and the two limits
 * are worth stating because the rule above reads around them rather than
 * solving them.
 *
 * The `minImageUsdPerImage` / `maxImageUsdPerImage` range is aggregated across
 * every protocol a peer publishes for that service (`resolveImagePriceRange`,
 * reached through `buildNetworkServiceOffers` in
 * `packages/node/src/discovery/service-catalog.ts`), while the peer's own
 * free-or-paid decision is made per request, for the protocol that request
 * selected (`selectBillingRoute` in
 * `packages/buyer-core/src/buyer-request-handler.ts`). A priced picture on a
 * text row therefore says the peer sells pictures for that model id, not that
 * it charges for a chat completion, so nothing in this listing can prove a chat
 * row costs money — and requiring a zero range on one would hide chat models
 * that are free.
 *
 * The unit model itself never travels in this listing at all: it is a map keyed
 * by protocol, and `/v1/models` flattens it to the range above. A row the peer's
 * own gate disagrees about is refused there rather than charged here, and the
 * refusal is an error the user can act on.
 *
 * The same goes for the answers themselves. The chat route always asks for a
 * stream, and the framing is what keeps an answer readable: a buffered body has
 * been seen carrying the SSE terminator after a complete JSON document, and a
 * peer may report its own upstream's failure inside a `200`, so a successful
 * status is not by itself a result. A body carrying no image is refused by
 * `persistGeneratedImages` — in that one place, and without the peer's own
 * words, because the media ladder classifies a route by the text of its error
 * (`mediaFallbackAllowed`) and a quoted message could turn a refusal that should
 * try the next route into a terminal one.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/antseed/provider
 */

import { withTimeout } from '../managed-catalog-utils.ts'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { OpenAiCompatibleConnection } from '../openai-compatible-adapter.ts'

/** Provider route the gateway's models are filed under. */
export const ANTSEED_PROVIDER_ID = 'antseed'

/**
 * Key sent to the local proxy. Never a secret — the proxy accepts any
 * non-empty value — and named as a placeholder so it is not stored in, or read
 * from, the credential vault.
 */
export const ANTSEED_PLACEHOLDER_API_KEY = 'antseed'

/**
 * Loopback port the buyer proxy listens on.
 *
 * Deliberately not `8377`, which is the CLI's own default: a user who also
 * runs the upstream CLI's buyer by hand would otherwise have the two fight over
 * one port, and the plugin would then be talking to a buyer it does not manage
 * (different data directory, different identity).
 */
export const ANTSEED_DEFAULT_PORT = 8390

/** How long one model-directory read may take. */
export const ANTSEED_DIRECTORY_TIMEOUT_MS = 8_000

/**
 * How long the settings card's own roster read may take.
 *
 * Much shorter than a picker read on purpose. The card is a summary drawn during
 * a page render, so a buyer that is wedged must cost a couple of seconds rather
 * than eight; a directory answered over loopback takes single-digit
 * milliseconds, so the shorter budget only ever expires on a buyer that is not
 * answering at all — which is the one thing the card cannot show a roster for.
 */
export const ANTSEED_STATUS_TIMEOUT_MS = 2_000

/** Lowest port this module will build an endpoint for. */
const MIN_PORT = 1024
/** Highest port this module will build an endpoint for. */
const MAX_PORT = 65535

/**
 * Whether a value is a port this module can build an endpoint for.
 *
 * Refuses privileged ports (the runtime cannot bind them as a normal user) and
 * anything that is not a whole number in range, so a bad setting is refused
 * where it is read rather than as a bind failure inside a child process.
 * @param value - the candidate port.
 * @returns whether the port is usable.
 */
export function isAntSeedPort(value: number): boolean {
  return Number.isSafeInteger(value) && value >= MIN_PORT && value <= MAX_PORT
}

/**
 * Base URL of the local buyer proxy for one port.
 * @param port - the loopback port the buyer runtime listens on.
 * @returns the OpenAI-compatible `/v1` endpoint root.
 */
export function antSeedLoopbackBaseUrl(port: number): string {
  if (!isAntSeedPort(port)) throw new Error(`The buyer port ${String(port)} is not a usable port number`)
  return `http://127.0.0.1:${String(port)}/v1`
}

/**
 * Which directory a model row came from.
 *
 * The buyer separates the two listings, and the distinction is not decorative:
 * a text row is a chat route the LLM adapter can serve, while an image row is
 * generated media, which the Harness reaches through its media route rather
 * than through the model adapter. Both are free offers on the same network, so
 * the card lists both and labels them.
 */
export type AntSeedModelKind = 'text' | 'images'

/**
 * What one seller charges for one model, as its offer advertises it.
 *
 * Every field is optional because a price that was not advertised is not the
 * same fact as a price of zero — a distinction this module keeps, since the
 * whole point of reading prices is to refuse to call an unknown one free.
 */
export interface AntSeedPeerPricing {
  /** USD per million input tokens. */
  readonly inputUsdPerMillion?: number
  /** USD per million output tokens. */
  readonly outputUsdPerMillion?: number
  /** USD per million cached input tokens, when the seller prices cache hits. */
  readonly cachedInputUsdPerMillion?: number
  /** Cheapest advertised price for one generated image. */
  readonly minImageUsdPerImage?: number
  /** Dearest advertised price for one generated image. */
  readonly maxImageUsdPerImage?: number
}

/** One model row as the buyer proxy reports it. */
export interface AntSeedModelRow {
  /** Model id the request names. */
  readonly id: string
  /** Display name, falling back to the id when the directory has none. */
  readonly name: string
  /** Which listing this row came from. */
  readonly kind: AntSeedModelKind
  /**
   * Whether every offer for this row advertises reasoning support.
   *
   * The buyer aggregates the capability across the row's offers and publishes it
   * only when they agree, so `false` is "no offer reasons" and `true` is "they
   * all do"; **absent** is the third state — one offer answered and another did
   * not — and it is not a `false`: the network said nothing, and reading silence
   * as a refusal would hide a control the row may well serve. That is why the
   * value is optional and why its consumers must not default it.
   */
  readonly reasoning?: boolean
  /**
   * Whether a request for this row can cost nothing, judged from the offers the
   * network advertises for it.
   *
   * Text rows are free when **one** offer is, because the buyer is started with
   * a zero price ceiling and its router drops every paid offer before ranking
   * (`>` against the ceiling, `plugins/router-local/src/router.ts`) — the paid
   * offers in such a row are unreachable, so they do not disqualify it. Image
   * rows must be free on **every** offer, because that ceiling only compares
   * token prices: it has no image equivalent, so a paid image offer stays
   * routable and a mixed row is a row that can charge.
   *
   * A row with no offers at all is not free: there is nothing to route to, and
   * an unreadable price is not a price of zero.
   */
  readonly free: boolean
}

/**
 * Read one advertised price.
 *
 * Only a finite, non-negative number is a price. `null`, a string, and a
 * negative value are all "not advertised" rather than "zero", because reading
 * any of them as zero is how a paid offer would end up in a list the user was
 * told was free.
 * @param value - the raw field.
 * @returns the price, or `undefined` when the field is not one.
 */
function advertisedPrice(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Read one offer's prices out of a `peers` entry.
 * @param entry - one entry of a model row's `peers` array.
 * @returns the advertised prices, or `undefined` when the entry is not an object.
 */
function parsePeerPricing(entry: unknown): AntSeedPeerPricing | undefined {
  if (entry === null || typeof entry !== 'object') return undefined
  const record = entry as Record<string, unknown>
  const inputUsdPerMillion = advertisedPrice(record['inputUsdPerMillion'])
  const outputUsdPerMillion = advertisedPrice(record['outputUsdPerMillion'])
  const cachedInputUsdPerMillion = advertisedPrice(record['cachedInputUsdPerMillion'])
  const minImageUsdPerImage = advertisedPrice(record['minImageUsdPerImage'])
  const maxImageUsdPerImage = advertisedPrice(record['maxImageUsdPerImage'])
  return {
    ...(inputUsdPerMillion === undefined ? {} : { inputUsdPerMillion }),
    ...(outputUsdPerMillion === undefined ? {} : { outputUsdPerMillion }),
    ...(cachedInputUsdPerMillion === undefined ? {} : { cachedInputUsdPerMillion }),
    ...(minImageUsdPerImage === undefined ? {} : { minImageUsdPerImage }),
    ...(maxImageUsdPerImage === undefined ? {} : { maxImageUsdPerImage }),
  }
}

/**
 * Whether one offer costs nothing for the kind of request this row serves.
 *
 * Mirrors the seller's own test, which needs both halves: a zero token price
 * **and** a zero priced unit. A seller that publishes neither is free on the
 * token half alone, and one that publishes a price for a picture is charging
 * no matter what its token price says.
 * @param price - the offer's advertised prices.
 * @param kind - which listing the row came from.
 * @returns whether the offer is priced at zero end to end.
 */
function isFreeOffer(price: AntSeedPeerPricing, kind: AntSeedModelKind): boolean {
  // `!== 0` rather than a `=== undefined` guard twice over: an absent token
  // price is not a zero one, and this reads that way.
  if (price.inputUsdPerMillion !== 0 || price.outputUsdPerMillion !== 0) return false
  // A published cache price must be zero as well, or the seller bills for the
  // second turn of a conversation. An unpublished one bills nothing.
  if (price.cachedInputUsdPerMillion !== undefined && price.cachedInputUsdPerMillion !== 0) return false
  // A text row stops here, and the image range above is deliberately left
  // unread. It is the peer's cheapest and dearest picture across *every*
  // protocol it publishes for this service, while the peer's free-or-paid
  // decision is made for the protocol the request selected — so a priced
  // picture on a chat row says the peer sells pictures for that model id, not
  // that this request is billed, and refusing the row over it would hide a chat
  // model that answers for nothing. The unit model is not in this listing at
  // all, so there is nothing else here to read: a row the peer's own gate
  // disagrees about comes back as a payment request, which is an error and not
  // a charge.
  if (kind === 'text') return true
  // The dearest advertised size is what decides: a seller that charges 0 for
  // 512x512 and 0.05 for 1024x1024 publishes both, and a request here names no
  // size, so the row can be billed at the higher one. This is also the buyer's
  // own test: `isFreeUnitBillingModel` is `every(priceUsd <= 0)` over the
  // components, and `isBillingRouteFree` requires a zero token price *and* a
  // unit model that is absent or free, so a row kept here is a row the buyer
  // will classify as free rather than as one to open a payment channel against.
  //
  // Only `output_images` components travel in this listing, so a unit model
  // built on some other unit is invisible from here; such a row would be kept
  // and then refused by the buyer's gate, which is an error and not a charge.
  const dearestPerImage = price.maxImageUsdPerImage ?? price.minImageUsdPerImage
  return dearestPerImage === undefined || dearestPerImage === 0
}

/**
 * Decide whether a row's offers add up to a free model.
 * @param prices - every price advertised for the row.
 * @param kind - which listing the row came from.
 * @returns whether the row may be offered as free.
 */
function isFreeRow(prices: readonly AntSeedPeerPricing[], kind: AntSeedModelKind): boolean {
  if (prices.length === 0) return false
  return kind === 'text'
    ? prices.some(price => isFreeOffer(price, kind))
    : prices.every(price => isFreeOffer(price, kind))
}

/**
 * Read one row's advertised reasoning capability out of its `capabilities` block.
 *
 * Only a boolean is a capability. The buyer publishes the aggregate of every
 * offer's own claim, and omits the field entirely when one offer answered and
 * another did not — so anything that is not a boolean (a missing block, a
 * number, a string) is carried as "not advertised" rather than resolved to a
 * default here. See {@link AntSeedModelRow.reasoning} for why that distinction
 * survives instead of collapsing to `false`.
 * @param capabilities - the raw `capabilities` field of one directory entry.
 * @returns the advertised capability, or `undefined` when the entry states none.
 */
function advertisedReasoning(capabilities: unknown): boolean | undefined {
  if (capabilities === null || typeof capabilities !== 'object') return undefined
  const value = (capabilities as { readonly reasoning?: unknown }).reasoning
  return typeof value === 'boolean' ? value : undefined
}

/**
 * Read the model rows out of a `/v1/models` answer.
 *
 * The proxy answers in the OpenAI directory shape (`{ data: [...] }`). An entry
 * without a usable id is skipped rather than named: a row the request cannot
 * address is worse than an absent one, because selecting it fails at the wire
 * with a message about the model instead of about the directory.
 *
 * Rows are returned whether or not they are free — this is the directory as the
 * network answered it, and {@link readAntSeedCatalog} is where the free ones are
 * separated from the rest. Dropping them here instead would leave nothing that
 * could say how many were left out.
 * @param payload - the parsed JSON body.
 * @param kind - the listing this body came from, stamped onto every row.
 * @returns the usable rows, in directory order.
 */
export function parseAntSeedModelDirectory(payload: unknown, kind: AntSeedModelKind = 'text'): readonly AntSeedModelRow[] {
  if (payload === null || typeof payload !== 'object') return []
  const data = (payload as { readonly data?: unknown }).data
  if (!Array.isArray(data)) return []
  const rows: AntSeedModelRow[] = []
  const seen = new Set<string>()
  for (const entry of data) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as {
      readonly id?: unknown
      readonly name?: unknown
      readonly peers?: unknown
      readonly capabilities?: unknown
    }
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    const offers = Array.isArray(record.peers) ? record.peers : []
    const prices = offers.map(parsePeerPricing).filter((price): price is AntSeedPeerPricing => price !== undefined)
    const reasoning = advertisedReasoning(record.capabilities)
    rows.push({
      id,
      name: name === '' ? id : name,
      kind,
      free: isFreeRow(prices, kind),
      ...(reasoning === undefined ? {} : { reasoning }),
    })
  }
  return rows
}

/** How one directory read is performed. */
export interface AntSeedDirectoryRead {
  /** The loopback port the buyer runtime listens on. */
  readonly port: number
  /** Which listing to read; text by default. */
  readonly kind?: AntSeedModelKind
  /** Request implementation; injectable so a test does not open a socket. */
  readonly fetchImplementation?: typeof fetch
  /** Aborts the read. */
  readonly signal?: AbortSignal
  /** Read timeout; defaults to {@link ANTSEED_DIRECTORY_TIMEOUT_MS}. */
  readonly timeoutMs?: number
}

/**
 * Read the models the local buyer currently serves.
 *
 * A failure here is an empty directory rather than a rejection: the model picker
 * asks this on every refresh, and a buyer that is installed but not started — or
 * one that has just been switched off — is a normal state, not an error the user
 * should see on a settings page.
 * @param read - the port and transport to read through.
 * @returns the served models, or an empty list when the proxy did not answer with a directory.
 */
export async function listAntSeedModels(read: AntSeedDirectoryRead): Promise<readonly AntSeedModelRow[]> {
  const base = antSeedLoopbackBaseUrl(read.port)
  const kind = read.kind ?? 'text'
  const send = read.fetchImplementation ?? fetch
  try {
    const answer = await withTimeout(
      send(`${base}/models?type=${kind}`, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${ANTSEED_PLACEHOLDER_API_KEY}` },
        ...(read.signal === undefined ? {} : { signal: read.signal }),
      }),
      read.timeoutMs ?? ANTSEED_DIRECTORY_TIMEOUT_MS,
      'Model directory read',
    )
    if (!answer.ok) return []
    return parseAntSeedModelDirectory(await answer.json(), kind)
  } catch {
    return []
  }
}

/**
 * Read one listing and keep only the rows that cost nothing.
 *
 * The reader for a caller that wants one kind of free model — the media route
 * asks for the image listing and nothing else. {@link readAntSeedCatalog} is the
 * same filter over both listings, and exists because the two callers that need
 * the whole picture (the model adapter and the settings card) need it together.
 * @param read - the port, which listing, and the transport to read through.
 * @returns the free rows of that listing, in directory order.
 */
export async function listFreeAntSeedModels(read: AntSeedDirectoryRead): Promise<readonly AntSeedModelRow[]> {
  return (await listAntSeedModels(read)).filter(row => row.free)
}

/**
 * The free models the local buyer serves, and how many it left out.
 *
 * The count is not decoration: it separates "this network has no free models"
 * from "this buyer has discovered nothing yet", which is the difference between
 * a settings page that explains itself and one that looks broken. It is what the
 * readiness wait reads to decide whether the buyer is up.
 */
export interface AntSeedCatalog {
  /** Rows that cost nothing, the text listing first, duplicates dropped by id. */
  readonly models: readonly AntSeedModelRow[]
  /** How many advertised rows were priced above zero and are not in `models`. */
  readonly paid: number
}

/**
 * Read every free model the local buyer serves: chat models and image models.
 *
 * Both listings are read because the card reports what the user can actually
 * reach, and the two are disjoint — an image model never appears in the text
 * listing and vice versa. A kind whose read fails contributes nothing rather
 * than failing the whole catalog: a buyer that serves no image models and a
 * buyer whose image listing errored look the same to a user who only wants to
 * chat, and neither should empty the card.
 *
 * Every paid row is counted and dropped. That is the whole contract of this
 * module: the plugin installs a buyer to reach free models, and the directory it
 * reads covers the entire network, so the filtering has to happen somewhere.
 * @param read - the port and transport to read through, without `kind`.
 * @returns the free rows of both listings, and the number of paid rows excluded.
 */
export async function readAntSeedCatalog(read: Omit<AntSeedDirectoryRead, 'kind'>): Promise<AntSeedCatalog> {
  const kinds: readonly AntSeedModelKind[] = ['text', 'images']
  const listings = await Promise.all(kinds.map(async kind => listAntSeedModels({ ...read, kind })))
  const models: AntSeedModelRow[] = []
  const seen = new Set<string>()
  let paid = 0
  for (const listing of listings) {
    for (const row of listing) {
      // Counted once per model, not once per listing: the same id appearing in
      // both is one model the user is not being offered.
      if (seen.has(row.id)) continue
      seen.add(row.id)
      if (!row.free) {
        paid += 1
        continue
      }
      models.push(row)
    }
  }
  return { models, paid }
}

/**
 * Project directory rows into the Harness model list.
 *
 * Only free text rows become model entries. Text, because an image row is
 * generated media — the Harness reaches it through its media route rather than
 * through the model adapter, and offering it here would present a chat route
 * that cannot answer. Free, because that is the only thing this plugin
 * promises: the image rows are not dropped, they travel another way (the
 * settings surface publishes the free ones as media routes, see the card's
 * `withAntSeedMediaModels`), and {@link requestAntSeedImage} is the transport
 * behind those routes.
 *
 * The free test is applied here as well as in {@link readAntSeedCatalog} so the
 * projection is correct for any input rather than only for the one caller that
 * happens to pass filtered rows.
 * @param rows - rows read from the buyer proxy.
 * @param provider - route the rows belong to.
 * @returns one model entry per free text row.
 */
export function toAntSeedModelInfo(rows: readonly AntSeedModelRow[], provider: string = ANTSEED_PROVIDER_ID): readonly LlmModelInfo[] {
  return rows.filter(row => row.free && row.kind === 'text').map(row => ({ provider, id: row.id, name: row.name }))
}

/**
 * The connection one of the gateway's models is served over.
 *
 * The caller is responsible for the gateway switch; this function only
 * describes the endpoint, so a route cannot be resolved by accident from a
 * place that never checked it.
 * @param port - the loopback port the buyer runtime listens on.
 * @param model - the model the request names.
 * @returns the OpenAI-compatible connection for that model.
 */
export function resolveAntSeedConnection(port: number, model: string): OpenAiCompatibleConnection {
  return { baseURL: antSeedLoopbackBaseUrl(port), apiKey: ANTSEED_PLACEHOLDER_API_KEY, model }
}

/**
 * How long one image generation may take.
 *
 * Far longer than a directory read, because this is not a lookup: the buyer has
 * to reach a seller, open a metered channel against the zero-priced contract,
 * and only then does the seller render anything. Five minutes is the ceiling a
 * user would still read as "working" rather than a budget this module expects to
 * spend; a directory that answers in milliseconds keeps its own short one.
 */
export const ANTSEED_IMAGE_TIMEOUT_MS = 5 * 60_000

/** How much of a failed answer is quoted back, so a seller's own words travel. */
const ANTSEED_ERROR_BODY_LIMIT = 300

/** One image request against the local buyer proxy. */
export interface AntSeedImageRequest {
  /** Loopback port the buyer runtime listens on. */
  readonly port: number
  /** The seller's image model id, without the provider prefix. */
  readonly model: string
  /** What to draw. */
  readonly prompt: string
  /** Requested size, when the caller named one. */
  readonly size?: string
  /** Requested quality, when the caller named one. */
  readonly quality?: string
  /** How many images to ask for; defaults to one. */
  readonly n?: number
  /** Aborts the request. */
  readonly signal?: AbortSignal
  /** Request implementation; injectable so a test does not open a socket. */
  readonly fetchImplementation?: typeof fetch
  /** Request timeout; defaults to {@link ANTSEED_IMAGE_TIMEOUT_MS}. */
  readonly timeoutMs?: number
}

/**
 * Generate one image through the local buyer.
 *
 * The opposite error policy to {@link listAntSeedModels}: a failure is raised
 * rather than swallowed. This is a request a user is waiting on, the media
 * ladder can only try another route if it sees this one fail, and an empty
 * picture reported as a success is the one outcome worse than an error.
 *
 * The answer body is deliberately not parsed here. Every image shape this plugin
 * accepts is read in one place (`persistGeneratedImages`), and a second reader
 * would be a second set of shapes to keep in step with the first.
 * @param request - the port, model, prompt, and transport to use.
 * @returns the parsed answer body.
 * @throws when the proxy answered with a failure status, or did not answer.
 */
export async function requestAntSeedImage(request: AntSeedImageRequest): Promise<unknown> {
  const base = antSeedLoopbackBaseUrl(request.port)
  const send = request.fetchImplementation ?? fetch
  const answer = await withTimeout(send(`${base}/images/generations`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${ANTSEED_PLACEHOLDER_API_KEY}`,
    },
    body: JSON.stringify({
      model: request.model,
      prompt: request.prompt,
      n: request.n ?? 1,
      // Base64 rather than a URL: the answer then carries the bytes themselves,
      // so the plugin stores the picture instead of depending on whatever a
      // seller's CDN link keeps serving afterwards.
      response_format: 'b64_json',
      ...(request.size === undefined ? {} : { size: request.size }),
      ...(request.quality === undefined ? {} : { quality: request.quality }),
    }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  }), request.timeoutMs ?? ANTSEED_IMAGE_TIMEOUT_MS, 'Image request')
  if (!answer.ok) throw new Error(`Image request failed with HTTP ${String(answer.status)}${await describeAntSeedFailure(answer)}`)
  return await answer.json() as unknown
}

/**
 * Quote the start of a failed answer, so the seller's own words reach the user.
 *
 * Best-effort in both directions: a body that cannot be read, or carries nothing,
 * contributes nothing rather than replacing the status that did explain the
 * failure, and the text is cut short because it is an error message riding inside
 * another error message.
 * @param answer - the failed response.
 * @returns the quoted detail, prefixed with a colon, or an empty string.
 */
async function describeAntSeedFailure(answer: Response): Promise<string> {
  try {
    const detail = (await answer.text()).trim().replace(/\s+/gu, ' ')
    return detail === '' ? '' : `: ${detail.slice(0, ANTSEED_ERROR_BODY_LIMIT)}`
  } catch {
    return ''
  }
}
