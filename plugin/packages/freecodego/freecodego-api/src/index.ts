/**
 * Client for the redacted FreeCodeGo Harness API. Credentials remain owned by
 * the host credential provider and are never retained by this package.
 *
 * @module @deepseek-ai/dsh-freecodego-api
 */

/** A selectable root-agent engine returned by the public catalog. */
export interface FreeCodeGoEngine {
  readonly id: 'deepseek' | 'codex' | 'claude'
  readonly enabled: boolean
  readonly availability: 'available' | 'unavailable' | 'updating'
  readonly reasons: readonly { readonly code: string; readonly retryable: boolean }[]
}

/**
 * Any JSON-serializable value, as the backend returns it.
 */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue }

/** HTTP failure with safe backend diagnostics retained for Host/UI reporting. */
export class FreeCodeGoHttpError extends Error {
    /**
   * HTTP status the backend answered with.
   */
readonly status: number
    /**
   * Response body retained for diagnostics, when the backend sent one.
   */
readonly body: string | undefined
    /**
   * Request id the backend echoed, for support correlation.
   */
readonly requestId: string | undefined

  constructor(message: string, status: number, body?: string, requestId?: string) {
    super(message)
    this.name = 'FreeCodeGoHttpError'
    this.status = status
    this.body = body
    this.requestId = requestId
  }
}

/** A model choice that can later be resolved by the trusted host. */
export interface FreeCodeGoRouteChoice {
  readonly routeKey: string
  readonly label: string
  readonly availability: string
  readonly compatibleEngines: readonly FreeCodeGoEngine['id'][]
  readonly groupId?: number
  readonly groupName?: string
  readonly protocol?: string
  /** Backend gate string as reported: `available` or `locked`. `free` only
   * appears on legacy deployments and is *not* a price signal. */
  readonly access?: string
  readonly unlockRequired?: boolean
  readonly unlockReason?: string
  readonly unlockExpiresAt?: string
  readonly zeroPrice: boolean
  /** Always present: `access === 'locked'` or `unlock_required` makes a route
   * locked for this account. Derived once by {@link isLockedRoute} so no caller
   * re-derives the rule from a partially reported payload. */
  readonly locked: boolean
  /** Effective backend group billing multiplier. Free routes are exposed as 0. */
  readonly rateMultiplier?: number
}

/** Redacted catalog used by the native host and Web projection. */
export interface FreeCodeGoCatalog {
  readonly apiVersion: string
  readonly catalogRevision: string
  readonly generatedAt: string
  readonly expiresAt: string
  readonly engines: readonly FreeCodeGoEngine[]
  readonly models: readonly {
    readonly id: string
    readonly displayName: string
    readonly provider: string
    readonly protocol: string
    readonly availability: string
    readonly compatibleEngines: readonly FreeCodeGoEngine['id'][]
    readonly choices: readonly FreeCodeGoRouteChoice[]
  }[]
}

/** Host-owned request dependency. The access token is never returned or cached. */
export interface FreeCodeGoCatalogRequest {
  readonly accessToken: string
  readonly deviceId?: string
  readonly deviceName?: string
  readonly clientVersion?: string
  readonly signal?: AbortSignal
}

/** Authenticated, browser-safe channel health published by the gateway. */
export interface FreeCodeGoGatewayProviderHealth {
  readonly provider: string
  readonly status: 'operational' | 'degraded' | 'failed' | 'error' | 'unknown'
  readonly latencyMs?: number
  readonly availability7d: number
}

/** Browser-safe route status; no lease or bearer token is included. */
export interface FreeCodeGoRouteStatus {
  readonly routeKey: string
  readonly state: 'available' | 'locked' | 'exhausted' | 'cooldown' | 'unavailable'
  readonly reason?: string
  readonly retryAt?: string
}

/**
 * The desktop checkout configuration the backend already publishes.
 *
 * `GET /api/v1/freecodego/payment/config` is the projection the backend built
 * for desktop clients: it drops the backend's tuning fields and keeps what a
 * checkout surface needs. Two of those fields have no other source — the real
 * per-order limits (`checkout-info`'s channel rows can carry `single_min`/
 * `single_max` as zeros, which is an absent limit, not a zero-width one) and the
 * **publishable** Stripe key, which is what lets a card form run inside the app
 * instead of sending the user to the backend's own checkout page.
 *
 * Only ever publishable material: `stripe_publishable_key` and `paypal_client_id`
 * are client keys by design, and this reader goes through the same
 * secret-rejecting path as every other read, so a deployment that ever sent a
 * secret here fails loudly instead of handing it to a browser.
 */
export interface FreeCodeGoDesktopPaymentConfig {
  readonly paymentEnabled: boolean
  readonly minAmount?: number
  readonly maxAmount?: number
  readonly dailyLimit?: number
  readonly orderTimeoutMinutes?: number
  readonly maxPendingOrders?: number
  /** Payment types the operator left enabled, in the backend's own spelling. */
  readonly enabledPaymentTypes: readonly string[]
  readonly balanceDisabled?: boolean
  readonly balanceRechargeMultiplier?: number
  readonly rechargeFeeRate?: number
  readonly helpText?: string
  readonly helpImageUrl?: string
  /** Stripe's client-side key; safe in a browser, and required by Stripe.js. */
  readonly stripePublishableKey?: string
  readonly paypalClientId?: string
}

/**
 * One checkout order and its settlement state.
 */
export interface FreeCodeGoCheckoutOrder {
  readonly orderId: string
  /** Backend order status; values are owned by the existing payment service. */
  readonly state: string
  /** Balance credit, denominated in USD (`order_type: balance`). */
  readonly amount: number
  /** Settlement currency of {@link payAmount}, **when the backend sent one**.
   *
   * The create-order response passes the payment provider's currency straight
   * through and only when the provider reported one: Alipay and WeChat echo no
   * currency, so `currency` is absent on their orders while a card provider
   * fills it. The absence is therefore about the provider, not about the order,
   * and it must not be papered over with a made-up `USD` — the number that
   * follows is charged in the channel's currency, which the caller knows from
   * the channel it just priced the order with. */
  readonly currency?: string
  readonly checkoutUrl?: string
  readonly qrCode?: string
  readonly clientSecret?: string
  readonly outTradeNo?: string
  readonly payAmount?: number
  readonly paymentType?: string
  readonly expiresAt?: string
  readonly entitlementRevision?: string
  /**
   * Whether the backend offers this order's commercial receipt.
   *
   * Carried by the two order reads that answer about *an existing* order —
   * `GET .../payment/orders/:id` and `POST .../payment/orders/verify` — and
   * absent from the create-order response, which cannot have a document for an
   * order nobody has paid yet. Absent must stay absent: the panel falls back to
   * its settled-state list only when no flag arrived, and a default here would
   * override the backend's answer on the one order that matters.
   */
  readonly receiptAvailable?: boolean
  /**
   * Whether Stripe itself holds a receipt for this order.
   *
   * The same two reads carry it, and it is true only for a payment Stripe took,
   * which is knowledge only the backend has: the panel must not infer it from
   * {@link paymentType}, because a channel's spelling is not a claim about which
   * issuer produced a document.
   */
  readonly stripeReceiptAvailable?: boolean
}

/** Server-accepted delivery result for an existing paid-order receipt. */
export interface FreeCodeGoReceiptEmailResult {
  readonly email: string
  readonly message?: string
}

/**
 * A paid order's receipt, as the backend serves it: one self-contained document.
 *
 * The backend already renders this file (a commercial receipt, not a tax
 * invoice) and serves it with its own filename and content type. Handling it as
 * a document rather than as JSON is what lets the plugin save exactly what the
 * backend issued instead of re-drawing a look-alike locally.
 */
export interface FreeCodeGoReceiptDocument {
  readonly fileName: string
  readonly contentType: string
  readonly content: string
  /**
   * How `content` carries the document's bytes.
   *
   * Absent means the text itself, which is what the commercial receipt is: the
   * backend renders HTML for it. Stripe's receipt is a PDF, and a PDF read as
   * text arrives with every byte this runtime cannot decode replaced — so a
   * binary document travels base64 encoded and the browser decodes it back into
   * the same bytes before offering the file.
   */
  readonly encoding?: 'text' | 'base64'
}

/**
 * The filename a receipt download should be saved under.
 *
 * Taken from the backend's own `Content-Disposition`, because the backend names
 * the file after the order; `fallbackName` is used only when the header is
 * missing or unusable. Anything that could escape a download directory — path
 * separators, quotes, control characters — is stripped: the header is ours, but
 * a filename travels straight into the browser's save dialog.
 * @param disposition - the `Content-Disposition` header, when the backend sent one.
 * @param fallbackName - name to use when that header carries no usable filename.
 * @returns the sanitized filename the receipt is saved under.
 */
export function receiptFileName(disposition: string | null | undefined, fallbackName: string): string {
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition ?? '')
  const candidate = (match?.[1] ?? '').trim()
  const cleaned = candidate.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '').replace(/^\.+/u, '').trim()
  return cleaned === '' ? fallbackName : cleaned
}

/** Existing payment-order input. The browser selects a visible backend payment method. */
export interface FreeCodeGoCheckoutRequest extends FreeCodeGoCatalogRequest {
  readonly planId: number
  readonly paymentType: string
  readonly returnUrl: string
  readonly amount?: number
  /** Desktop clients explicitly request a QR/H5-capable checkout. */
  readonly isMobile?: boolean
}

/** Normalized account profile returned by the existing FreeCodeGo `/auth/me` route. */
export interface FreeCodeGoCurrentUser {
  readonly id?: number
  readonly username?: string
  readonly email?: string
  readonly avatarUrl?: string
  readonly role?: string
  readonly balance?: number
  readonly status?: string
}

/** One Warp Agent desktop device session of the signed-in account. */
export interface FreeCodeGoDeviceSession {
  readonly deviceId: string
  readonly deviceName?: string
  readonly os?: string
  readonly arch?: string
  readonly clientVersion?: string
  readonly localGatewayId?: string
  readonly lastSeenAt: string
  readonly createdAt: string
  readonly revokedAt?: string
  readonly current: boolean
  readonly revoked: boolean
}

/** Device-session listing; the backend marks which row belongs to this client. */
export interface FreeCodeGoDeviceSessionList {
  readonly currentDeviceId?: string
  readonly sessions: readonly FreeCodeGoDeviceSession[]
}

/** Existing FreeCodeGo payment plan projection. */
export interface FreeCodeGoPaymentPlan {
  readonly id: number | string
  readonly name: string
  readonly description?: string
  readonly price?: number
  readonly originalPrice?: number
  readonly currency?: string
  readonly validityDays?: number
  readonly validityUnit?: string
  readonly features?: readonly string[]
  readonly productName?: string
  readonly forSale?: boolean
}

/** Visible payment method returned by the existing FreeCodeGo payment API. */
export interface FreeCodeGoPaymentChannel {
  readonly paymentType: string
  readonly currency?: string
  readonly balanceRechargeMultiplier?: number
  readonly feeRate?: number
  readonly fixedFee?: number
  readonly fixedFeeDisplayAmount?: number
  readonly fixedFeeDisplayCurrency?: string
  readonly singleMin?: number
  readonly singleMax?: number
}

/** Combined checkout projection used by the existing FreeCodeGo payment page. */
export interface FreeCodeGoPaymentCheckoutInfo {
  readonly plans: readonly FreeCodeGoPaymentPlan[]
  readonly channels: readonly FreeCodeGoPaymentChannel[]
}

/** One resolution tier of an image-billing model.
 *
 * The backend bills image generation **per image**, not per token, and prices it
 * per group in three resolution tiers (`groups.image_price_1k/2k/4k`). A row
 * that quotes `inputPricePerMillion`/`outputPricePerMillion` for such a model is
 * quoting columns the charge never reads, so the tiers travel as their own field
 * instead of being folded into the token prices. */
export interface FreeCodeGoImagePriceTier {
  /** The backend's own tier label, kept verbatim (`1K` / `2K` / `4K`). */
  readonly label: string
  /** Effective price per generated image, the group rate already applied. */
  readonly price: number
  /** The group's configured unit price before the group rate. Present only when
   * it differs from {@link price}, so a struck-through original is never shown
   * for a row that carries no discount. */
  readonly originalPrice?: number
}

/** One effective gateway tariff. Prices are USD per million tokens unless the
 * row uses `per-request` or `image` billing; an `image` row prices each generated
 * picture and carries {@link FreeCodeGoGatewayModelPrice.imagePrices} instead of
 * usable token columns. The Host derives account-visible values from the
 * backend-owned model-option group and pricing snapshot. */
export interface FreeCodeGoGatewayModelPrice {
  readonly modelId: string
  readonly displayName: string
  readonly provider: string
  readonly source: 'gateway' | 'bai' | 'empero' | 'opencode' | 'openrouter' | 'logfare' | 'workbuddy' | 'agnes' | 'sensenova'
  readonly groupName: string
  readonly platform?: string
  readonly rateMultiplier: number
  readonly billingMode: 'token' | 'per-request' | 'image'
  readonly currency: string
  readonly description?: string
  /** Official catalog price before the selected gateway multiplier. */
  readonly originalInputPricePerMillion?: number
  readonly originalOutputPricePerMillion?: number
  readonly originalCacheReadPricePerMillion?: number
  readonly originalCacheWritePricePerMillion?: number
  readonly originalPerRequestPrice?: number
  /** Catalog price per million image-output tokens. Distinct from
   * {@link imagePrices}: it prices image *tokens* for a model that still
   * reports them, while the tiers price whole pictures. */
  readonly originalImageOutputPricePerMillion?: number
  readonly inputPricePerMillion?: number
  readonly outputPricePerMillion?: number
  readonly cacheReadPricePerMillion?: number
  readonly cacheWritePricePerMillion?: number
  readonly perRequestPrice?: number
  readonly imageOutputPricePerMillion?: number
  /** Per-image tiers from the row's backend group, in the row's currency.
   * Empty or absent means the backend quoted no per-image price for this group,
   * which is a missing price rather than a free one. */
  readonly imagePrices?: readonly FreeCodeGoImagePriceTier[]
}

/** Host-only managed runtime credentials used to reach the FreeCodeGo gateway.
 * Built by the Host (see harness-plugin `managedRuntime`) from the vault access
 * token and a per-model route key; it is never fetched from a dedicated route. */
export interface FreeCodeGoManagedRuntime {
  readonly openAIBaseUrl?: string
  readonly anthropicBaseUrl?: string
  readonly openAIToken?: string
  readonly anthropicToken?: string
  readonly tokenType?: string
  readonly tokenExpiresAt?: string
  readonly tokenRefreshAt?: string
  readonly routeKeys: readonly { readonly routeKey?: string; readonly protocol?: string; readonly model?: string; readonly groupId?: number; readonly token: string }[]
}

/**
 * One `/models/options` model and its per-group choices.
 *
 * Required fields are the ones the backend always emits and the Host relies on
 * (`id`, `options[].group_id`, `options[].route_key`, `options[].enabled`,
 * `options[].rate_multiplier`, plus the derived `zeroPrice`/`locked`). Display
 * fields (`display_name`, `provider`, `description`, `group_name`, `plan_code`)
 * and pricing blocks are dropped when the backend omits them.
 */
export interface FreeCodeGoModelRouteOption {
  readonly model: string
  readonly displayName?: string
  readonly provider?: string
  readonly description?: string
  readonly protocol?: string
  readonly options: readonly {
    /** Group identity; a choice without it cannot be pinned or ordered. */
    readonly groupId: number
    /** The route header value sent on inference requests. Required. */
    readonly routeKey: string
    readonly protocol?: string
    readonly enabled: boolean
    /** `available`/`locked` as reported by the backend (see
     * {@link FreeCodeGoRouteChoice.access}). */
    readonly access?: string
    readonly unlockRequired?: boolean
    readonly unlockReason?: string
    readonly unlockExpiresAt?: string
    readonly planCode?: string
    /** Always present for backend rows (`rate_multiplier: 0` means free);
     * omitted only when the backend sends no multiplier at all. */
    readonly rateMultiplier?: number
    readonly groupName?: string
    /** Derived by {@link isFreeRouteRow}; never omitted. */
    readonly zeroPrice: boolean
    /** Derived by {@link isLockedRoute}; never omitted. */
    readonly locked: boolean
    readonly billingMode?: 'token' | 'per-request' | 'image'
    readonly currency?: string
    readonly originalInputPricePerMillion?: number
    readonly originalOutputPricePerMillion?: number
    readonly originalCacheReadPricePerMillion?: number
    readonly originalCacheWritePricePerMillion?: number
    readonly originalPerRequestPrice?: number
    readonly originalImageOutputPricePerMillion?: number
    readonly inputPricePerMillion?: number
    readonly outputPricePerMillion?: number
    readonly cacheReadPricePerMillion?: number
    readonly cacheWritePricePerMillion?: number
    readonly perRequestPrice?: number
    readonly imageOutputPricePerMillion?: number
  }[]
}

/**
 * One group as `/models/options` reports it, projected to what a UI may show.
 *
 * Groups are the account-facing plans a model can be reached through. The name
 * is the only heading a user recognises, `sort_order` is the order the backend
 * wants them listed in, and `rate_multiplier` is already the *account's*
 * effective rate — the backend folds the per-user override in before it
 * answers, so a consumer must not re-apply one.
 */
export interface FreeCodeGoModelOptionGroup {
  readonly id: number
  readonly name: string
  readonly description?: string
  readonly platform?: string
  readonly protocol?: string
  readonly planCode?: string
  readonly enabled: boolean
  readonly access?: string
  readonly unlockRequired?: boolean
  readonly unlockReason?: string
  readonly unlockExpiresAt?: string
  /** The account's default group, when the backend marks one. */
  readonly default?: boolean
  readonly modelCount?: number
  /** Already the account's effective rate; `0` means free. */
  readonly rateMultiplier?: number
  readonly activityDiscountPercent?: number
  readonly activityLabel?: string
  readonly sortOrder?: number
  /** Whether the group is allowed to generate images at all. Absent means the
   * backend did not say, not that generation is disabled. */
  readonly allowImageGeneration?: boolean
  /** Whether image generation uses a rate independent of
   * {@link rateMultiplier} (`groups.image_rate_independent`). */
  readonly imageRateIndependent?: boolean
  /** The image rate, honoured only when {@link imageRateIndependent} is true. */
  readonly imageRateMultiplier?: number
  /** Group unit price for one 1K image, before any rate is applied. */
  readonly imagePrice1K?: number
  readonly imagePrice2K?: number
  readonly imagePrice4K?: number
}

/** Both halves of the `/models/options` projection, read in one request. */
export interface FreeCodeGoModelOptionsSnapshot {
  readonly groups: readonly FreeCodeGoModelOptionGroup[]
  readonly models: readonly FreeCodeGoModelRouteOption[]
}

/** Request budget for a call that only reads what the backend already has.
 *
 * A read is cheap and its latency is the backend's own; a longer budget buys
 * nothing and turns a stalled gateway into a UI that hangs. */
export const FREECODEGO_READ_TIMEOUT_MS = 8_000

/** Request budget for a call the backend forwards to a payment provider.
 *
 * Creating an order makes the backend talk to Alipay / WeChat / Stripe /
 * Airwallex and wait for a provider order id or a payment URL. That round trip
 * routinely outlives a read budget, and aborting it is not a harmless retry:
 * the provider order may already exist, so the client gets no order id to open,
 * poll, or cancel, and the user's click looks like a button that does nothing
 * while orphaned pending orders accumulate against the account's pending-order
 * limit. Money paths therefore get a budget sized for the provider, not for
 * the backend's database. */
export const FREECODEGO_PROVIDER_TIMEOUT_MS = 45_000

/** Which budget a request spends, named at the call site that knows why. */
export type FreeCodeGoRequestBudget = 'read' | 'provider'

/** Constructor values for a public FreeCodeGo API client. */
export interface FreeCodeGoApiOptions {
  readonly baseUrl: string
  readonly fetch?: typeof globalThis.fetch
  readonly allowInsecureLocalhost?: boolean
  /** Override the per-budget timeouts, in milliseconds. A private deployment
   * behind a slow provider raises the provider budget here rather than
   * loosening every read in the client. */
  readonly timeouts?: Readonly<Partial<Record<FreeCodeGoRequestBudget, number>>>
}

export * from './mobile-auth.ts'
export * from './account-coordinator.ts'
export * from './refresh-guard.ts'
export * from './third-party.ts'

/** Normalized (lowercase, non-alphanumerics stripped) secret field names. */
const FORBIDDEN_KEYS = new Set([
  'accesstoken', 'apikey', 'authtoken', 'authorization',
  'clientsecret', 'credential', 'fingerprinthash', 'refreshtoken', 'secret', 'token',
])

/** Suffixes that mark a field as credential-bearing regardless of prefix. */
// `secretkey` is listed beside `secret` because the suffix check below is an
// `endsWith`: a provider credentials field is spelled `stripe_secret_key` — and
// `...secretkey` does not end in `secret`, so it slipped past the exact-name and
// suffix checks while carrying the most dangerous value of all.
const FORBIDDEN_KEY_SUFFIXES = ['token', 'secret', 'secretkey', 'apikey', 'password', 'credential']

/** Fetches and validates only the public, redacted catalog projection. */
export class FreeCodeGoApiClient {
  private readonly budgetMs: Readonly<Record<FreeCodeGoRequestBudget, number>>
  private readonly baseUrl: URL
  private readonly fetch: typeof globalThis.fetch

  constructor(options: FreeCodeGoApiOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl, options.allowInsecureLocalhost === true)
    this.fetch = options.fetch ?? globalThis.fetch
    if (typeof this.fetch !== 'function') throw new Error('FreeCodeGo API requires a fetch implementation')
    const configured = options.timeouts ?? {}
    const budget = (kind: FreeCodeGoRequestBudget, fallback: number): number => {
      const value = configured[kind]
      if (value === undefined) return fallback
      if (!Number.isFinite(value) || value <= 0) throw new Error(`FreeCodeGo API timeout for ${kind} requests must be a positive number of milliseconds`)
      return value
    }
    this.budgetMs = {
      read: budget('read', FREECODEGO_READ_TIMEOUT_MS),
      provider: budget('provider', FREECODEGO_PROVIDER_TIMEOUT_MS),
    }
  }

  /**
   * Request the authenticated model catalog without retaining the bearer token.
   * @param request - host-provided bearer token and optional cancellation.
   * @returns a catalog that contains no credential-bearing fields.
   */
  async getCatalog(request: FreeCodeGoCatalogRequest): Promise<FreeCodeGoCatalog> {
    const bootstrap = await this.getBootstrap(request)
    return normalizeBootstrapCatalog(bootstrap)
  }

  /** Read public gateway tariffs without accessing an account or its tokens. 
   * @param language - locale the returned labels are written in.
   * @returns the gateway Model Price rows, in backend order.
   * @param options - per-call bounds such as an abort signal.
   */
  async getPublicModelPricing(language: 'zh' | 'en', options: { readonly signal?: AbortSignal } = {}): Promise<readonly FreeCodeGoGatewayModelPrice[]> {
    const payload = object(await this.public('/api/v1/public/model-pricing/landing', language, options.signal === undefined ? {} : { signal: options.signal }), 'public model pricing')
    return normalizePublicModelPricing(payload)
  }

  /** Look up official prices for model IDs absent from the public landing
   * catalog. This is intentionally public and returns only price fields. 
   * @param language - locale the returned labels are written in.
   * @param models - the model ids to look up.
   * @param options - per-call bounds such as an abort signal.
   * @returns one price lookup per requested model id, found or not.
   */
  async getPublicModelPricingLookup(models: readonly string[], language: 'zh' | 'en' = 'en', options: { readonly signal?: AbortSignal } = {}): Promise<readonly {
    readonly model: string
    readonly found: boolean
    readonly billingMode: 'token' | 'per-request' | 'image'
    readonly currency: string
    readonly inputPricePerMillion?: number
    readonly outputPricePerMillion?: number
    readonly cacheReadPricePerMillion?: number
    readonly cacheWritePricePerMillion?: number
    readonly perRequestPrice?: number
    readonly imageOutputPricePerMillion?: number
  }[]> {
    const names = [...new Set(models.map(model => model.trim()).filter(model => model !== ''))].slice(0, 500)
    if (names.length === 0) return []
    const payload = await this.public('/api/v1/public/model-pricing/lookup', language, { method: 'POST', body: { models: names }, ...(options.signal === undefined ? {} : { signal: options.signal }) })
    const root = object(payload, 'public model pricing lookup')
    const items = Array.isArray(root.items) ? root.items : []
    return items.flatMap((value) => {
      const item = object(value, 'public model pricing lookup item')
      const model = typeof item.model === 'string' ? item.model.trim() : ''
      if (model === '') return []
      const number = (field: string): number | undefined => finiteOptionalNumber(item[field])
      const billingMode = gatewayBillingMode(item.billing_mode)
      const currency = typeof item.currency === 'string' && item.currency.trim() !== '' ? item.currency.trim() : 'USD'
      const inputPricePerMillion = number('input_price_per_million')
      const outputPricePerMillion = number('output_price_per_million')
      const cacheReadPricePerMillion = number('cache_read_price_per_million')
      const cacheWritePricePerMillion = number('cache_write_price_per_million')
      const perRequestPrice = number('per_request_price')
      const imageOutputPricePerMillion = number('image_output_price_per_million')
      return [{ model, found: item.found === true, billingMode, currency,
        ...(inputPricePerMillion === undefined ? {} : { inputPricePerMillion }),
        ...(outputPricePerMillion === undefined ? {} : { outputPricePerMillion }),
        ...(cacheReadPricePerMillion === undefined ? {} : { cacheReadPricePerMillion }),
        ...(cacheWritePricePerMillion === undefined ? {} : { cacheWritePricePerMillion }),
        ...(perRequestPrice === undefined ? {} : { perRequestPrice }),
        ...(imageOutputPricePerMillion === undefined ? {} : { imageOutputPricePerMillion }),
      }]
    })
  }

  /** Fetch the existing group-aware FreeCodeGo model options projection. 
   * @param request - the request this call projects from.
   * @returns the model Route Option rows, in backend order.
   */
  async getModelOptions(request: FreeCodeGoCatalogRequest): Promise<readonly FreeCodeGoModelRouteOption[]> {
    return (await this.getModelOptionsSnapshot(request)).models
  }

  /**
   * Read `/models/options` once and return both halves of its projection.
   *
   * The response carries the account's groups beside the models, and the backend
   * derives both from one snapshot of the account's entitlements. A caller that
   * needs the group list — to label a picker with the real group names, in the
   * backend's order, at the account's effective rate — would otherwise read the
   * same endpoint twice.
   * @param request - the request this call projects from.
   * @returns the model Options Snapshot.
   */
  async getModelOptionsSnapshot(request: FreeCodeGoCatalogRequest): Promise<FreeCodeGoModelOptionsSnapshot> {
    const root = object(await this.authorized('/api/v1/freecodego/models/options', request), 'model options')
    const payload = unwrapData(root, 'model options')
    const projected = Array.isArray(payload) ? undefined : object(payload, 'model options')
    const models = projected === undefined ? payload : projected.models
    if (!Array.isArray(models)) throw new Error('FreeCodeGo model options.models must be an array')
    const groups = normalizeModelOptionGroups(projected?.groups)
    const optionRows = models.map((value) => {
      const item = object(value, 'model option')
      if (typeof item.id !== 'string' || item.id.trim() === '') throw new Error('FreeCodeGo model option id is required')
      if (!Array.isArray(item.options)) throw new Error(`FreeCodeGo model options for ${item.id} must be an array`)
      // Captured before the inner map: an index-signature read narrows only for
      // the enclosing scope, so `item.id` inside the callback is `unknown`.
      const id = item.id
      const options = item.options.map((candidate) => {
        const choice = object(candidate, 'model option choice')
        if (typeof choice.group_id !== 'number' || !Number.isFinite(choice.group_id)) throw new Error(`FreeCodeGo model option ${id} group_id is required`)
        if (typeof choice.route_key !== 'string' || choice.route_key.trim() === '') throw new Error(`FreeCodeGo model option ${id} route_key is required`)
        const officialPricing = object(choice.official_pricing, 'model option official pricing')
        const activityPricing = object(choice.activity_pricing, 'model option activity pricing')
        // The backend's real free signal is a zero rate multiplier: `access` only
        // ever carries `available`/`locked`, and pricing has no `free` mode. The
        // legacy `access === 'free'`/`billing_mode === 'free'` spellings are kept
        // so an older deployment still resolves, but the multiplier is what makes
        // a route free today.
        const declaredRate = finiteOptionalNumber(choice.rate_multiplier)
        const zeroPrice = isFreeRouteRow(choice, officialPricing, activityPricing)
        const rateMultiplier = zeroPrice ? 0 : declaredRate
        const access = typeof choice.access === 'string' && choice.access.trim() !== '' ? choice.access.trim() : undefined
        const unlockRequired = choice.unlock_required === true
        const locked = isLockedRoute({ ...(access === undefined ? {} : { access }), ...(unlockRequired ? { unlockRequired: true } : {}) })
        const price = (root: Record<string, unknown>, key: string): number | undefined => finiteOptionalNumber(root[key])
        const originalInputPricePerMillion = price(officialPricing, 'input_price_per_million')
        const originalOutputPricePerMillion = price(officialPricing, 'output_price_per_million')
        const originalCacheReadPricePerMillion = price(officialPricing, 'cache_read_price_per_million')
        const originalCacheWritePricePerMillion = price(officialPricing, 'cache_write_price_per_million')
        const originalPerRequestPrice = price(officialPricing, 'per_request_price')
        const originalImageOutputPricePerMillion = price(officialPricing, 'image_output_price_per_million')
        const inputPricePerMillion = price(activityPricing, 'input_price_per_million')
        const outputPricePerMillion = price(activityPricing, 'output_price_per_million')
        const cacheReadPricePerMillion = price(activityPricing, 'cache_read_price_per_million')
        const cacheWritePricePerMillion = price(activityPricing, 'cache_write_price_per_million')
        const perRequestPrice = price(activityPricing, 'per_request_price')
        const imageOutputPricePerMillion = price(activityPricing, 'image_output_price_per_million')
        return {
          groupId: choice.group_id,
          routeKey: choice.route_key,
          ...(typeof choice.group_name === 'string' && choice.group_name.trim() !== '' ? { groupName: choice.group_name } : {}),
          ...(typeof choice.protocol === 'string' ? { protocol: choice.protocol } : {}),
          enabled: choice.enabled !== false,
          ...(access === undefined ? {} : { access }),
          ...(unlockRequired ? { unlockRequired: true } : {}),
          ...(typeof choice.unlock_reason === 'string' && choice.unlock_reason.trim() !== '' ? { unlockReason: choice.unlock_reason } : {}),
          ...(typeof choice.unlock_expires_at === 'string' && choice.unlock_expires_at.trim() !== '' ? { unlockExpiresAt: choice.unlock_expires_at } : {}),
          ...(typeof choice.plan_code === 'string' && choice.plan_code.trim() !== '' ? { planCode: choice.plan_code } : {}),
          zeroPrice,
          locked,
          ...(rateMultiplier === undefined ? {} : { rateMultiplier }),
          // Only the two non-token modes are authoritative here: `token` is the
          // catalog's own default, so a model missing from the model square would
          // report token even when the backend charges it per image. The public
          // lookup stays the fallback for that case.
          ...(activityPricing.billing_mode === 'per_request' || activityPricing.billing_mode === 'image' ? { billingMode: gatewayBillingMode(activityPricing.billing_mode) } : {}),
          ...(typeof activityPricing.currency === 'string' && activityPricing.currency.trim() !== '' ? { currency: activityPricing.currency.trim() } : {}),
          ...(originalInputPricePerMillion === undefined ? {} : { originalInputPricePerMillion }),
          ...(originalOutputPricePerMillion === undefined ? {} : { originalOutputPricePerMillion }),
          ...(originalCacheReadPricePerMillion === undefined ? {} : { originalCacheReadPricePerMillion }),
          ...(originalCacheWritePricePerMillion === undefined ? {} : { originalCacheWritePricePerMillion }),
          ...(originalPerRequestPrice === undefined ? {} : { originalPerRequestPrice }),
          ...(originalImageOutputPricePerMillion === undefined ? {} : { originalImageOutputPricePerMillion }),
          ...(inputPricePerMillion === undefined ? {} : { inputPricePerMillion }),
          ...(outputPricePerMillion === undefined ? {} : { outputPricePerMillion }),
          ...(cacheReadPricePerMillion === undefined ? {} : { cacheReadPricePerMillion }),
          ...(cacheWritePricePerMillion === undefined ? {} : { cacheWritePricePerMillion }),
          ...(perRequestPrice === undefined ? {} : { perRequestPrice }),
          ...(imageOutputPricePerMillion === undefined ? {} : { imageOutputPricePerMillion }),
        }
      })
      return [{
        model: item.id,
        ...(typeof item.label === 'string' && item.label.trim() !== '' ? { displayName: item.label.trim() } : {}),
        ...(typeof item.provider === 'string' && item.provider.trim() !== '' ? { provider: item.provider.trim() } : {}),
        ...(typeof item.description === 'string' && item.description.trim() !== '' ? { description: item.description.trim() } : {}),
        ...(typeof item.protocol === 'string' ? { protocol: item.protocol } : {}),
        options,
      }]
    }).flat()
    return { groups, models: optionRows }
  }

  /** Fetch the existing managed FreeCodeGo bootstrap response. 
   * @param request - the request this call projects from.
   * @returns the projected record the caller renders.
   */
  async getBootstrap(request: FreeCodeGoCatalogRequest): Promise<Record<string, unknown>> {
    return this.authorized('/api/v1/freecodego/agent/bootstrap', request, {
      method: 'POST',
      body: {
        device_id: request.deviceId,
        device_name: request.deviceName,
        client_version: request.clientVersion,
      },
    }) as Promise<Record<string, unknown>>
  }

  /** Fetch the existing account profile route. 
   * @param request - the request this call projects from.
   * @returns the current User.
   */
  async getCurrentUser(request: FreeCodeGoCatalogRequest): Promise<FreeCodeGoCurrentUser> {
    const root = object(await this.authorized('/api/v1/freecodego/auth/me', request), 'current user')
    const user = object(root.user ?? root.profile ?? root, 'current user')
    return {
      ...(typeof user.id === 'number' ? { id: user.id } : {}),
      ...(typeof user.username === 'string' ? { username: user.username } : {}),
      ...(typeof user.email === 'string' ? { email: user.email } : {}),
      ...(typeof user.avatar_url === 'string' && user.avatar_url.trim() !== '' ? { avatarUrl: user.avatar_url.trim() } : typeof user.avatarUrl === 'string' && user.avatarUrl.trim() !== '' ? { avatarUrl: user.avatarUrl.trim() } : {}),
      ...(typeof user.role === 'string' ? { role: user.role } : {}),
      ...(typeof user.balance === 'number' ? { balance: user.balance } : {}),
      ...(typeof user.status === 'string' ? { status: user.status } : {}),
    }
  }

  /**
   * List this account's desktop device sessions. `device_id` is sent as the
   * query parameter the backend uses to mark the caller's own row instead of
   * guessing from the newest active row.
   * @param request - the request this call projects from.
   * @returns the device Session List.
   */
  async getDeviceSessions(request: FreeCodeGoCatalogRequest): Promise<FreeCodeGoDeviceSessionList> {
    const query = request.deviceId === undefined || request.deviceId.trim() === '' ? '' : `?device_id=${encodeURIComponent(request.deviceId.trim())}`
    const payload = object(await this.authorized(`/api/v1/freecodego/auth/device-sessions${query}`, request), 'device sessions')
    const sessions = array(payload.sessions ?? [], 'device sessions.sessions').map((value, index) => {
      const item = object(value, `device sessions.sessions[${index}]`)
      return {
        deviceId: string(item.device_id, `device sessions.sessions[${index}].device_id`),
        ...(typeof item.device_name === 'string' && item.device_name.trim() !== '' ? { deviceName: item.device_name.trim() } : {}),
        ...(typeof item.os === 'string' && item.os.trim() !== '' ? { os: item.os.trim() } : {}),
        ...(typeof item.arch === 'string' && item.arch.trim() !== '' ? { arch: item.arch.trim() } : {}),
        ...(typeof item.client_version === 'string' && item.client_version.trim() !== '' ? { clientVersion: item.client_version.trim() } : {}),
        ...(typeof item.local_gateway_id === 'string' && item.local_gateway_id.trim() !== '' ? { localGatewayId: item.local_gateway_id.trim() } : {}),
        lastSeenAt: typeof item.last_seen_at === 'string' ? item.last_seen_at : '',
        createdAt: typeof item.created_at === 'string' ? item.created_at : '',
        ...(typeof item.revoked_at === 'string' && item.revoked_at.trim() !== '' ? { revokedAt: item.revoked_at.trim() } : {}),
        current: item.current === true,
        revoked: item.revoked === true,
      }
    })
    return {
      ...(typeof payload.current_device_id === 'string' && payload.current_device_id.trim() !== '' ? { currentDeviceId: payload.current_device_id.trim() } : {}),
      sessions,
    }
  }

  /** Revoke one device session by id; the returned message is the backend's own. 
   * @param request - the device id to revoke, scoped to the account.
   * @returns the backend's own confirmation message.
   */
  async revokeDeviceSession(request: FreeCodeGoCatalogRequest & { readonly deviceId: string }): Promise<string> {
    const deviceId = request.deviceId.trim()
    if (deviceId === '') throw new Error('FreeCodeGo device id is required')
    const payload = object(await this.authorized('/api/v1/freecodego/auth/device-sessions/revoke', request, { method: 'POST', body: { device_id: deviceId } }), 'revoke device session')
    return typeof payload.message === 'string' ? payload.message.trim() : ''
  }

  /** Revoke every session of the account and return how many the backend revoked. 
   * @param request - the request this call projects from.
   * @returns how many sessions the backend revoked.
   */
  async revokeAllSessions(request: FreeCodeGoCatalogRequest): Promise<number> {
    const payload = object(await this.authorized('/api/v1/freecodego/auth/revoke-all-sessions', request, { method: 'POST' }), 'revoke all sessions')
    return finiteOptionalNumber(payload.revoked_count) ?? 0
  }

  /** Fetch quota through the existing FreeCodeGo endpoint. 
   * @param request - the request this call projects from.
   * @returns the projected record the caller renders.
   */
  async getQuota(request: FreeCodeGoCatalogRequest): Promise<Record<string, unknown>> {
    return this.authorized('/api/v1/freecodego/agent/quota', request) as Promise<Record<string, unknown>>
  }

  /** Fetch runtime health through the existing FreeCodeGo endpoint. 
   * @param request - the request this call projects from.
   * @returns the projected record the caller renders.
   */
  async getRuntimeHealth(request: FreeCodeGoCatalogRequest): Promise<Record<string, unknown>> {
    return this.authorized('/api/v1/freecodego/agent/runtime/health', request) as Promise<Record<string, unknown>>
  }

  /** Fetch the narrow Provider health projection reserved for FreeCodeGo Agents. 
   * @param request - the request this call projects from.
   * @returns the gateway Provider Health rows, in backend order.
   */
  async getGatewayProviderHealth(request: FreeCodeGoCatalogRequest): Promise<readonly FreeCodeGoGatewayProviderHealth[]> {
    const payload = object(await this.authorized('/api/v1/freecodego/agent/channel-health', request), 'gateway channel health')
    return array(payload.items, 'gateway channel health.items').map((value, index) => {
      const item = object(value, `gateway channel health.items[${index}]`)
      const latencyMs = nonNegativeOptionalNumber(item.latency_ms)
      const availability = finiteOptionalNumber(item.availability_7d) ?? 0
      return {
        provider: string(item.provider, 'gateway channel health.provider'),
        status: channelMonitorStatus(item.status),
        ...(latencyMs === undefined ? {} : { latencyMs }),
        availability7d: Math.max(0, Math.min(100, availability)),
      }
    })
  }

  /** Fetch usage through the existing FreeCodeGo endpoint. 
   * @returns the projected record the caller renders.
   * @param request - the usage window to read.
   */
  async getUsage(request: FreeCodeGoCatalogRequest & { readonly days?: number }): Promise<Record<string, unknown>> {
    const suffix = request.days === undefined ? '' : `?days=${encodeURIComponent(String(request.days))}`
    return this.authorized(`/api/v1/freecodego/agent/usage${suffix}`, request) as Promise<Record<string, unknown>>
  }

  /** Fetch the account-scoped usage dashboard summary used by the FreeCodeGo client. 
   * @param request - the request this call projects from.
   * @returns the projected record the caller renders.
   */
  async getUsageDashboardStats(request: FreeCodeGoCatalogRequest): Promise<Record<string, unknown>> {
    return this.authorized('/api/v1/freecodego/usage/dashboard/stats', request) as Promise<Record<string, unknown>>
  }

  /** Fetch account-scoped usage trend buckets. 
   * @returns the projected record the caller renders.
   * @param request - the dashboard window to read.
   */
  async getUsageDashboardTrend(request: FreeCodeGoCatalogRequest & { readonly startDate?: string; readonly endDate?: string; readonly granularity?: 'hour' | 'day' }): Promise<Record<string, unknown>> {
    const params = new URLSearchParams()
    if (request.startDate !== undefined) params.set('start_date', request.startDate)
    if (request.endDate !== undefined) params.set('end_date', request.endDate)
    if (request.granularity !== undefined) params.set('granularity', request.granularity)
    const suffix = params.toString() === '' ? '' : `?${params.toString()}`
    return this.authorized(`/api/v1/freecodego/usage/dashboard/trend${suffix}`, request) as Promise<Record<string, unknown>>
  }

  /** Fetch account-scoped model usage rows. 
   * @returns the projected record the caller renders.
   * @param request - the dashboard window to read.
   */
  async getUsageDashboardModels(request: FreeCodeGoCatalogRequest & { readonly startDate?: string; readonly endDate?: string }): Promise<Record<string, unknown>> {
    const params = new URLSearchParams()
    if (request.startDate !== undefined) params.set('start_date', request.startDate)
    if (request.endDate !== undefined) params.set('end_date', request.endDate)
    const suffix = params.toString() === '' ? '' : `?${params.toString()}`
    return this.authorized(`/api/v1/freecodego/usage/dashboard/models${suffix}`, request) as Promise<Record<string, unknown>>
  }

  /** Fetch account-scoped cache and billing insights. 
   * @returns the projected record the caller renders.
   * @param request - the dashboard window to read.
   */
  async getUsageDashboardInsights(request: FreeCodeGoCatalogRequest & { readonly startDate?: string; readonly endDate?: string }): Promise<Record<string, unknown>> {
    const params = new URLSearchParams()
    if (request.startDate !== undefined) params.set('start_date', request.startDate)
    if (request.endDate !== undefined) params.set('end_date', request.endDate)
    const suffix = params.toString() === '' ? '' : `?${params.toString()}`
    return this.authorized(`/api/v1/freecodego/usage/dashboard/insights${suffix}`, request) as Promise<Record<string, unknown>>
  }

  // The narrower `/freecodego/payment/channels` and `/freecodego/payment/plans`
  // compatibility projections are deliberately not exposed: `checkout-info`
  // below is the only producer whose `methods` map carries the fee and limit
  // fields the checkout UI reads, so a second channel reader would be a second
  // source of truth for the same money path.

  /** Fetch the authenticated user's sanitized payment orders. 
   * @returns the json Value.
   * @param request - the order filters to read.
   */
  async getPaymentOrders(request: FreeCodeGoCatalogRequest & { readonly status?: string }): Promise<JsonValue> {
    // Order records carry the same host-only fields as checkout responses
    // (e.g. `client_secret` for card flows). Rejecting them here would fail
    // the whole list whenever one order includes that field.
    //
    // `status` is the backend's own filter (it normalizes `paid`/`completed`). It
    // matters because the list is paginated newest-first: a settled order can sit
    // on page 2 while the visible page is full of expired attempts, so a caller
    // that needs a settled order has to ask for that state instead of paging.
    const query = request.status === undefined || request.status.trim() === '' ? '' : `?status=${encodeURIComponent(request.status.trim())}`
    return toJsonValue(await this.authorized(`/api/v1/freecodego/payment/orders/my${query}`, request, {}, true))
  }

  /** Fetch the same combined plans/methods payload used by FreeCodeGo's checkout UI. 
   * @param request - the request this call projects from.
   * @returns the payment Checkout Info.
   */
  async getPaymentCheckoutInfo(request: FreeCodeGoCatalogRequest): Promise<FreeCodeGoPaymentCheckoutInfo> {
    // The existing web checkout is mounted on the shared authenticated
    // payment group, while FreeCodeGo's compatibility group exposes the
    // narrower plans/channels projections.
    const root = object(await this.authorized('/api/v1/payment/checkout-info', request), 'checkout info')
    const payload = object(unwrapData(root, 'checkout info'), 'checkout info')
    if (!Array.isArray(payload.plans)) throw new Error('FreeCodeGo checkout info plans must be an array')
    const rawPlans = payload.plans
    const plans = rawPlans.map((value) => {
      const item = object(value, 'checkout plan')
      if (typeof item.id !== 'number' && typeof item.id !== 'string') throw new Error('FreeCodeGo checkout plan id is required')
      if (typeof item.name !== 'string' || item.name.trim() === '') throw new Error('FreeCodeGo checkout plan name is required')
      if (typeof item.price !== 'number' || !Number.isFinite(item.price) || item.price <= 0) throw new Error(`FreeCodeGo checkout plan ${String(item.id)} price is required`)
      // Balance-credit plans returned by older FreeCodeGo deployments omit
      // `currency`; their prices are USD credits and the selected payment
      // channel performs the actual settlement-currency conversion. Keep the
      // plan usable while retaining strict currency validation for orders.
      const currency = typeof item.currency === 'string' && item.currency.trim() !== '' ? item.currency : 'USD'
      return { id: item.id, name: item.name, ...(typeof item.description === 'string' ? { description: item.description } : {}), price: item.price, ...(typeof item.original_price === 'number' ? { originalPrice: item.original_price } : {}), currency, ...(typeof item.validity_days === 'number' ? { validityDays: item.validity_days } : {}), ...(typeof item.validity_unit === 'string' ? { validityUnit: item.validity_unit } : {}), ...(Array.isArray(item.features) ? { features: item.features.filter((feature): feature is string => typeof feature === 'string') } : {}), ...(typeof item.product_name === 'string' ? { productName: item.product_name } : {}), ...(typeof item.for_sale === 'boolean' ? { forSale: item.for_sale } : {}) }
    })
    if (payload.methods === null || typeof payload.methods !== 'object' || Array.isArray(payload.methods)) throw new Error('FreeCodeGo checkout info methods must be an object')
    const methods = payload.methods as Record<string, unknown>
    const channels = Object.entries(methods).flatMap(([paymentType, value]) => {
      const item = object(value, `checkout method ${paymentType}`)
      if (item.available === false) return []
      if (paymentType.trim() === '') throw new Error('FreeCodeGo checkout method payment type is required')
      if (typeof item.currency !== 'string' || item.currency.trim() === '') throw new Error(`FreeCodeGo checkout method ${paymentType} currency is required`)
      if (typeof item.balance_recharge_multiplier !== 'number' || !Number.isFinite(item.balance_recharge_multiplier) || item.balance_recharge_multiplier <= 0) throw new Error(`FreeCodeGo checkout method ${paymentType} balance multiplier is required`)
      return [{ paymentType, currency: item.currency, balanceRechargeMultiplier: item.balance_recharge_multiplier, ...(typeof item.fee_rate === 'number' ? { feeRate: item.fee_rate } : {}), ...(typeof item.fixed_fee === 'number' ? { fixedFee: item.fixed_fee } : {}), ...(typeof item.fixed_fee_display_amount === 'number' ? { fixedFeeDisplayAmount: item.fixed_fee_display_amount } : {}), ...(typeof item.fixed_fee_display_currency === 'string' ? { fixedFeeDisplayCurrency: item.fixed_fee_display_currency } : {}), ...(typeof item.single_min === 'number' ? { singleMin: item.single_min } : {}), ...(typeof item.single_max === 'number' ? { singleMax: item.single_max } : {}) }]
    })
    return { plans, channels }
  }

  /** Read the desktop-safe payment configuration (see
   * {@link FreeCodeGoDesktopPaymentConfig}). 
   * @param request - the request this call projects from.
   * @returns the desktop Payment Config.
   */
  async getDesktopPaymentConfig(request: FreeCodeGoCatalogRequest): Promise<FreeCodeGoDesktopPaymentConfig> {
    const payload = object(await this.authorized('/api/v1/freecodego/payment/config', request), 'payment config')
    const bool = (field: string): boolean | undefined => typeof payload[field] === 'boolean' ? payload[field] : undefined
    const number = (field: string): number | undefined => finiteOptionalNumber(payload[field])
    const text = (field: string): string | undefined => {
      const value = payload[field]
      return typeof value === 'string' && value.trim() !== '' ? value : undefined
    }
    const types = Array.isArray(payload.enabled_payment_types)
      ? payload.enabled_payment_types.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      : []
    // Each field is read once into a local so the absent case removes the key
    // entirely (this package compiles with `exactOptionalPropertyTypes`).
    const minAmount = number('min_amount')
    const maxAmount = number('max_amount')
    const dailyLimit = number('daily_limit')
    const orderTimeoutMinutes = number('order_timeout_minutes')
    const maxPendingOrders = number('max_pending_orders')
    const balanceDisabled = bool('balance_disabled')
    const balanceRechargeMultiplier = number('balance_recharge_multiplier')
    const rechargeFeeRate = number('recharge_fee_rate')
    const helpText = text('help_text')
    const helpImageUrl = text('help_image_url')
    const stripePublishableKey = text('stripe_publishable_key')
    const paypalClientId = text('paypal_client_id')
    return {
      // The backend spells the master switch `payment_enabled`; a deployment
      // that omits it entirely is treated as enabled, because "missing" is not
      // "off" and guessing "off" would empty a working payment section.
      paymentEnabled: bool('payment_enabled') ?? true,
      ...(minAmount === undefined ? {} : { minAmount }),
      ...(maxAmount === undefined ? {} : { maxAmount }),
      ...(dailyLimit === undefined ? {} : { dailyLimit }),
      ...(orderTimeoutMinutes === undefined ? {} : { orderTimeoutMinutes }),
      ...(maxPendingOrders === undefined ? {} : { maxPendingOrders }),
      enabledPaymentTypes: types,
      ...(balanceDisabled === undefined ? {} : { balanceDisabled }),
      ...(balanceRechargeMultiplier === undefined ? {} : { balanceRechargeMultiplier }),
      ...(rechargeFeeRate === undefined ? {} : { rechargeFeeRate }),
      ...(helpText === undefined ? {} : { helpText }),
      ...(helpImageUrl === undefined ? {} : { helpImageUrl }),
      ...(stripePublishableKey === undefined ? {} : { stripePublishableKey }),
      ...(paypalClientId === undefined ? {} : { paypalClientId }),
    }
  }

    /**
   * Create a checkout order for one plan and payment method.
   * @param request - the plan, payment type, and return URLs of the order.
   * @returns the created order.
   */
async createCheckout(request: FreeCodeGoCheckoutRequest): Promise<FreeCodeGoCheckoutOrder> {
    const body: Record<string, unknown> = {
      return_url: request.returnUrl,
      payment_type: request.paymentType,
      // Match the official FreeCodeGo checkout flow. Unknown payment_source
      // values are accepted by the backend but can suppress provider URLs.
      payment_source: 'hosted_redirect',
      order_type: request.planId > 0 ? 'subscription' : 'balance',
      is_mobile: request.isMobile === true,
      ...(request.planId > 0 ? { plan_id: request.planId } : {}),
      ...(request.amount === undefined ? {} : { amount: request.amount }),
    }
    // The provider budget, not the read budget: this call waits on the payment
    // provider, and an abort here loses the order id the user needs to pay (see
    // `FREECODEGO_PROVIDER_TIMEOUT_MS`).
    //
    // The client-scoped route, not the shared one: the backend registers
    // `POST /api/v1/freecodego/payment/orders` as "an order for the desktop
    // client without exposing provider internals", and only the shared
    // `POST /api/v1/payment/orders` sits behind the backend-mode user guard —
    // where a request that does not carry the desktop installation secret is
    // refused for ordinary users. Order reading, verification, cancellation and
    // receipts already travel the scoped group, so creating one there is also
    // the only shape in which the whole order lifecycle shares a surface. The
    // sanitized response keeps every field this client reads.
    const payload = await this.authorized('/api/v1/freecodego/payment/orders', request, { method: 'POST', body, budget: 'provider' }, true)
    return parseOrder(object(payload, 'checkout'))
  }

    /**
   * Read one checkout order's current state.
   * @param request - the order id, scoped to the account.
   * @returns the order as the backend reports it.
   */
async getCheckoutOrder(request: FreeCodeGoCatalogRequest & { readonly orderId: string }): Promise<FreeCodeGoCheckoutOrder> {
    const payload = await this.authorized(`/api/v1/freecodego/payment/orders/${encodeURIComponent(request.orderId)}`, request, {}, true)
    return parseOrder(object(payload, 'order'))
  }

  /** Verify a payment through the existing out-trade-number endpoint. 
   * @returns the checkout Order.
   * @param request - the out-trade number to re-verify with the payment provider.
   */
  async verifyCheckoutOrder(request: FreeCodeGoCatalogRequest & { readonly outTradeNo: string }): Promise<FreeCodeGoCheckoutOrder> {
    // Verification asks the provider what it thinks of the out-trade number, so
    // it needs the provider budget for the same reason order creation does.
    const payload = await this.authorized('/api/v1/freecodego/payment/orders/verify', request, { method: 'POST', body: { out_trade_no: request.outTradeNo }, budget: 'provider' }, true)
    return parseOrder(object(payload, 'verified order'))
  }

  /** Cancel a pending payment through the existing endpoint. 
   * @param request - the order to cancel.
   */
  async cancelCheckoutOrder(request: FreeCodeGoCatalogRequest & { readonly orderId: string }): Promise<void> {
    await this.authorized(`/api/v1/freecodego/payment/orders/${encodeURIComponent(request.orderId)}/cancel`, request, { method: 'POST' })
  }

  /** Ask the existing backend to email the receipt; no receipt or token crosses Remote. 
   * @returns the receipt Email Result.
   * @param request - the order whose receipt is mailed.
   */
  async emailCheckoutReceipt(request: FreeCodeGoCatalogRequest & { readonly orderId: string }): Promise<FreeCodeGoReceiptEmailResult> {
    const result = object(await this.authorized(`/api/v1/freecodego/payment/orders/${encodeURIComponent(request.orderId)}/receipt/email`, request, { method: 'POST' }), 'receipt email')
    return { email: string(result.email, 'receipt email.email'), ...(typeof result.message === 'string' ? { message: result.message } : {}) }
  }

  /**
   * Fetch the receipt document for a paid order.
   *
   * Read with the read budget: the backend renders a template and returns it, so
   * this is not a call that waits on a payment provider. A rejected fetch throws
   * with the backend's own message, which the panel shows as "receipt is
   * available after payment is completed" for an order that has not settled.
   * @returns the receipt Document.
   * @param request - the order whose receipt is downloaded.
   */
  async downloadCheckoutReceipt(request: FreeCodeGoCatalogRequest & { readonly orderId: string }): Promise<FreeCodeGoReceiptDocument> {
    if (request.accessToken.trim() === '') throw new Error('FreeCodeGo access token is required')
    const path = `/api/v1/freecodego/payment/orders/${encodeURIComponent(request.orderId)}/receipt`
    const response = await this.fetch(new URL(path, this.baseUrl), {
      headers: { authorization: `Bearer ${request.accessToken}`, accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(this.budgetMs.read),
    })
    const content = await response.text()
    if (!response.ok) throw new Error(`FreeCodeGo request ${path} failed with HTTP ${response.status}: ${content.slice(0, 200)}`)
    return {
      fileName: receiptFileName(response.headers.get('content-disposition'), `freecodego-receipt-${request.orderId}.html`),
      contentType: response.headers.get('content-type') ?? 'text/html; charset=utf-8',
      content,
    }
  }

  /**
   * Fetch Stripe's own receipt for a paid Stripe order.
   *
   * A separate call rather than a flag on the receipt above, because it is a
   * different document from a different issuer: the commercial receipt is the
   * one this backend draws for every order, and this one is the PDF Stripe
   * rendered for the charge. The backend fetches it so the buyer saves a file
   * here instead of being sent to a hosted page that expires.
   * @returns the receipt Document, with the PDF's bytes base64 encoded.
   * @param request - the order whose Stripe receipt is downloaded.
   */
  async downloadCheckoutStripeReceipt(request: FreeCodeGoCatalogRequest & { readonly orderId: string }): Promise<FreeCodeGoReceiptDocument> {
    if (request.accessToken.trim() === '') throw new Error('FreeCodeGo access token is required')
    const path = `/api/v1/freecodego/payment/orders/${encodeURIComponent(request.orderId)}/stripe-receipt`
    // The provider budget, unlike the receipt above: this backend has no document
    // of its own to return, it has to ask Stripe for one first.
    const response = await this.fetch(new URL(path, this.baseUrl), {
      headers: { authorization: `Bearer ${request.accessToken}`, accept: 'application/pdf' },
      signal: AbortSignal.timeout(this.budgetMs.provider),
    })
    // Bytes, not text: the body is a PDF, and `response.text()` would replace
    // every byte that is not valid UTF-8 before it ever reached the browser. The
    // rejected case is read through the same bytes because an error body is the
    // backend's JSON, which this call still has to quote in its message.
    const body = Buffer.from(await response.arrayBuffer())
    if (!response.ok) throw new Error(`FreeCodeGo request ${path} failed with HTTP ${response.status}: ${body.toString('utf8').slice(0, 200)}`)
    return {
      fileName: receiptFileName(response.headers.get('content-disposition'), `freecodego-stripe-receipt-${request.orderId}.pdf`),
      contentType: response.headers.get('content-type') ?? 'application/pdf',
      content: body.toString('base64'),
      encoding: 'base64',
    }
  }

  private async authorized(path: string, request: FreeCodeGoCatalogRequest, extra: { method?: string; body?: Record<string, unknown>; budget?: FreeCodeGoRequestBudget } = {}, allowHostOnlySecrets = false): Promise<unknown> {
    if (request.accessToken.trim() === '') throw new Error('FreeCodeGo access token is required')
    const timeout = AbortSignal.timeout(this.budgetMs[extra.budget ?? 'read'])
    // A caller's own signal still ends its wait early; the budget is the ceiling
    // for a request nobody else cancels.
    const requestSignal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout])
    const response = await this.fetch(new URL(path, this.baseUrl), {
      method: extra.method ?? 'GET',
      headers: { authorization: `Bearer ${request.accessToken}`, accept: 'application/json', ...(extra.body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(extra.body === undefined ? {} : { body: JSON.stringify(extra.body) }),
      signal: requestSignal,
    })
    const responseText = await response.text()
    let payload: unknown
    if (responseText.trim() !== '') {
      try { payload = JSON.parse(responseText) } catch { payload = undefined }
    }
    if (!response.ok) {
      const root = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : undefined
      const message = typeof root?.message === 'string' ? root.message : typeof root?.error === 'string' ? root.error : undefined
      const safeBody = redactBackendBody(responseText)
      const requestId = response.headers.get('x-request-id') ?? response.headers.get('x-freecodego-request-id') ?? undefined
      throw new FreeCodeGoHttpError(`FreeCodeGo request ${path} failed with HTTP ${response.status}${message === undefined ? '' : `: ${message}`}${requestId === undefined ? '' : ` (request_id=${requestId})`}${safeBody === undefined ? '' : ` body=${safeBody}`}`, response.status, safeBody, requestId)
    }
    if (!allowHostOnlySecrets) rejectSecrets(payload)
    return unwrapData(payload, path)
  }

  private async public(path: string, language: 'zh' | 'en', extra: { readonly method?: string; readonly body?: Record<string, unknown>; readonly signal?: AbortSignal } = {}): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.budgetMs.read)
    const requestSignal = extra.signal === undefined ? timeout : AbortSignal.any([extra.signal, timeout])
    const response = await this.fetch(new URL(path, this.baseUrl), {
      method: extra.method ?? 'GET',
      headers: { accept: 'application/json', 'accept-language': language, ...(extra.body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(extra.body === undefined ? {} : { body: JSON.stringify(extra.body) }),
      signal: requestSignal,
    })
    const responseText = await response.text()
    let payload: unknown
    if (responseText.trim() !== '') {
      try { payload = JSON.parse(responseText) } catch { payload = undefined }
    }
    if (!response.ok) {
      const root = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : undefined
      const message = typeof root?.message === 'string' ? root.message : typeof root?.error === 'string' ? root.error : undefined
      const safeBody = redactBackendBody(responseText)
      const requestId = response.headers.get('x-request-id') ?? response.headers.get('x-freecodego-request-id') ?? undefined
      throw new FreeCodeGoHttpError(`FreeCodeGo request ${path} failed with HTTP ${response.status}${message === undefined ? '' : `: ${message}`}${requestId === undefined ? '' : ` (request_id=${requestId})`}${safeBody === undefined ? '' : ` body=${safeBody}`}`, response.status, safeBody, requestId)
    }
    rejectSecrets(payload)
    return unwrapData(payload, path)
  }
}

function redactBackendBody(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer <redacted>')
    .replace(/("(?:auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|api[_-]?key|client[_-]?secret|secret|password|credential|token)"\s*:\s*")[^"]+("\s*)/gi, '$1<redacted>$2')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 4096)
}

function unwrapData(value: unknown, label: string): unknown {
  const root = object(value, label)
  return root.data === undefined ? value : root.data
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(item => toJsonValue(item))
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, toJsonValue(nested)]))
  return String(value)
}

type PublicPricing = {
  readonly billingMode: 'token' | 'per-request' | 'image'
  readonly currency: string
  readonly inputPricePerMillion?: number
  readonly outputPricePerMillion?: number
  readonly cacheReadPricePerMillion?: number
  readonly cacheWritePricePerMillion?: number
  readonly perRequestPrice?: number
  readonly imageOutputPricePerMillion?: number
}

/**
 * The backend's `billing_mode` wire value, in this client's spelling.
 *
 * The backend publishes three modes (`token` / `per_request` / `image`). An
 * unrecognized value has to resolve to something, and `token` is the safe
 * default: it is the backend's own default, and it renders the model's quoted
 * token prices rather than promising a per-image price nobody sent.
 */
function gatewayBillingMode(value: unknown): 'token' | 'per-request' | 'image' {
  if (value === 'per_request') return 'per-request'
  if (value === 'image') return 'image'
  return 'token'
}

function normalizePublicModelPricing(value: Record<string, unknown>): readonly FreeCodeGoGatewayModelPrice[] {
  const catalog = Array.isArray(value.catalog) ? value.catalog : Array.isArray(value.models) ? value.models : []
  const groups = Array.isArray(value.groups) ? value.groups : []
  const rules = value.group_billing_rules !== null && typeof value.group_billing_rules === 'object' && !Array.isArray(value.group_billing_rules)
    ? value.group_billing_rules as Record<string, unknown> : {}
  const activeGroups = groups.flatMap((group) => {
    const item = object(group, 'public model pricing group')
    const id = finiteOptionalNumber(item.id)
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    const multiplier = finiteOptionalNumber(item.rate_multiplier)
    if (id === undefined || id <= 0 || name === '' || multiplier === undefined || multiplier < 0) return []
    return [{ id: Math.floor(id), name, multiplier, ...(typeof item.platform === 'string' && item.platform.trim() !== '' ? { platform: item.platform.trim() } : {}), allowedModels: Array.isArray(item.allowed_models) ? item.allowed_models.filter((candidate): candidate is string => typeof candidate === 'string') : [] }]
  })
  const rows: FreeCodeGoGatewayModelPrice[] = []
  for (const value of catalog) {
    const model = object(value, 'public model pricing model')
    if (model.enabled === false) continue
    const modelId = typeof model.model === 'string' ? model.model.trim() : typeof model.id === 'string' ? model.id.trim() : ''
    if (modelId === '') continue
    const official = parsePublicPricing(model)
    const displayName = typeof model.label === 'string' && model.label.trim() !== '' ? model.label.trim() : modelId
    const provider = typeof model.provider === 'string' && model.provider.trim() !== '' ? model.provider.trim() : 'FreeCodeGo'
    const description = typeof model.description === 'string' && model.description.trim() !== '' ? model.description.trim() : undefined
    for (const group of activeGroups) {
      if (group.allowedModels.length > 0 && !group.allowedModels.some(pattern => publicModelPatternMatches(pattern, modelId))) continue
      const rule = findPublicPricingRule(rules[String(group.id)], modelId)
      const price = applyPublicPricingRule(official, group.multiplier, rule)
      rows.push({ modelId, displayName, provider, source: 'gateway', groupName: group.name, ...(group.platform === undefined ? {} : { platform: group.platform }), rateMultiplier: group.multiplier, ...officialPriceFields(official), ...price, ...(description === undefined ? {} : { description }) })
    }
  }
  return rows.sort((left, right) => left.modelId.localeCompare(right.modelId) || left.groupName.localeCompare(right.groupName))
}

function officialPriceFields(pricing: PublicPricing): Pick<FreeCodeGoGatewayModelPrice, 'originalInputPricePerMillion' | 'originalOutputPricePerMillion' | 'originalCacheReadPricePerMillion' | 'originalCacheWritePricePerMillion' | 'originalPerRequestPrice'> {
  return {
    ...(pricing.inputPricePerMillion === undefined ? {} : { originalInputPricePerMillion: pricing.inputPricePerMillion }),
    ...(pricing.outputPricePerMillion === undefined ? {} : { originalOutputPricePerMillion: pricing.outputPricePerMillion }),
    ...(pricing.cacheReadPricePerMillion === undefined ? {} : { originalCacheReadPricePerMillion: pricing.cacheReadPricePerMillion }),
    ...(pricing.cacheWritePricePerMillion === undefined ? {} : { originalCacheWritePricePerMillion: pricing.cacheWritePricePerMillion }),
    ...(pricing.perRequestPrice === undefined ? {} : { originalPerRequestPrice: pricing.perRequestPrice }),
    ...(pricing.imageOutputPricePerMillion === undefined ? {} : { originalImageOutputPricePerMillion: pricing.imageOutputPricePerMillion }),
  }
}

function parsePublicPricing(value: Record<string, unknown>): PublicPricing {
  const billingMode = gatewayBillingMode(value.billing_mode)
  const currency = typeof value.currency === 'string' && value.currency.trim() !== '' ? value.currency.trim() : 'USD'
  const inputPricePerMillion = finiteOptionalNumber(value.input_price_per_million)
  const outputPricePerMillion = finiteOptionalNumber(value.output_price_per_million)
  const cacheReadPricePerMillion = finiteOptionalNumber(value.cache_read_price_per_million)
  const cacheWritePricePerMillion = finiteOptionalNumber(value.cache_write_price_per_million)
  const perRequestPrice = finiteOptionalNumber(value.per_request_price)
  const imageOutputPricePerMillion = finiteOptionalNumber(value.image_output_price_per_million)
  return {
    billingMode,
    currency,
    ...(inputPricePerMillion === undefined ? {} : { inputPricePerMillion }),
    ...(outputPricePerMillion === undefined ? {} : { outputPricePerMillion }),
    ...(cacheReadPricePerMillion === undefined ? {} : { cacheReadPricePerMillion }),
    ...(cacheWritePricePerMillion === undefined ? {} : { cacheWritePricePerMillion }),
    ...(perRequestPrice === undefined ? {} : { perRequestPrice }),
    ...(imageOutputPricePerMillion === undefined ? {} : { imageOutputPricePerMillion }),
  }
}

function findPublicPricingRule(value: unknown, modelId: string): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map(item => object(item, 'public model pricing rule')).find(rule => rule.enabled !== false && typeof rule.model === 'string' && publicModelPatternMatches(rule.model, modelId))
}

function applyPublicPricingRule(official: PublicPricing, multiplier: number, rule: Record<string, unknown> | undefined): PublicPricing {
  const perRequest = rule?.mode === 'per_request' ? finiteOptionalNumber(rule.per_request_price) : undefined
  if (perRequest !== undefined) return { billingMode: 'per-request', currency: official.currency, perRequestPrice: perRequest }
  const multiply = (value: number | undefined): number | undefined => value === undefined ? undefined : value * multiplier
  const inputPricePerMillion = multiply(official.inputPricePerMillion)
  const outputPricePerMillion = multiply(official.outputPricePerMillion)
  const cacheReadPricePerMillion = multiply(official.cacheReadPricePerMillion)
  const cacheWritePricePerMillion = multiply(official.cacheWritePricePerMillion)
  const perRequestPrice = multiply(official.perRequestPrice)
  const imageOutputPricePerMillion = multiply(official.imageOutputPricePerMillion)
  return {
    // The rule scales the tariff; it does not change how the model is billed,
    // so an image-billed model stays image-billed after the group multiplier.
    billingMode: official.billingMode,
    currency: official.currency,
    ...(inputPricePerMillion === undefined ? {} : { inputPricePerMillion }),
    ...(outputPricePerMillion === undefined ? {} : { outputPricePerMillion }),
    ...(cacheReadPricePerMillion === undefined ? {} : { cacheReadPricePerMillion }),
    ...(cacheWritePricePerMillion === undefined ? {} : { cacheWritePricePerMillion }),
    ...(perRequestPrice === undefined ? {} : { perRequestPrice }),
    ...(imageOutputPricePerMillion === undefined ? {} : { imageOutputPricePerMillion }),
  }
}

function publicModelPatternMatches(pattern: string, modelId: string): boolean {
  const normalizedPattern = pattern.trim().toLowerCase()
  const normalizedModel = modelId.trim().toLowerCase()
  return normalizedPattern !== '' && normalizedModel !== '' && (normalizedPattern === normalizedModel || (normalizedPattern.endsWith('*') && normalizedModel.startsWith(normalizedPattern.slice(0, -1))))
}

function normalizeBootstrapCatalog(value: Record<string, unknown>): FreeCodeGoCatalog {
  const models = Array.isArray(value.models) ? value.models : []
  const normalized = models.map((item) => {
    const model = object(item, 'bootstrap.model')
    const id = string(model.id, 'bootstrap.model.id')
    const protocol = typeof model.protocol === 'string' ? model.protocol : 'openai-responses'
    if (typeof model.route_key !== 'string' || model.route_key.trim() === '') throw new Error(`FreeCodeGo bootstrap model ${id} route_key is required`)
    const routeKey = model.route_key
    // The FreeCodeGo bootstrap projection strips group info and pricing, so a
    // free route here can only be recognized from the legacy spellings plus any
    // `rate_multiplier` a LiteAgent-era deployment still sends. Group-level free
    // and lock state arrive through `/models/options` instead.
    const declaredRate = finiteOptionalNumber(model.rate_multiplier)
    const zeroPrice = isFreeRouteRow(model)
    const rateMultiplier = zeroPrice ? 0 : declaredRate
    const access = typeof model.access === 'string' && model.access.trim() !== '' ? model.access.trim() : undefined
    const unlockRequired = model.unlock_required === true
    const locked = isLockedRoute({ ...(access === undefined ? {} : { access }), ...(unlockRequired ? { unlockRequired: true } : {}) })
    const availability = model.enabled === false ? 'unavailable' : 'available'
    return {
      id,
      displayName: typeof model.label === 'string' && model.label !== '' ? model.label : id,
      provider: typeof model.provider === 'string' ? model.provider : 'freecodego-cloud',
      protocol,
      availability,
      compatibleEngines: ['deepseek', 'codex', 'claude'] as const,
      choices: [{
        routeKey,
        label: routeKey,
        availability,
        compatibleEngines: ['deepseek', 'codex', 'claude'] as const,
        ...(typeof model.group_id === 'number' && Number.isFinite(model.group_id) ? { groupId: model.group_id } : {}),
        ...(typeof model.group_name === 'string' && model.group_name.trim() !== '' ? { groupName: model.group_name.trim() } : {}),
        ...(access === undefined ? {} : { access }),
        ...(unlockRequired ? { unlockRequired: true } : {}),
        ...(typeof model.unlock_reason === 'string' && model.unlock_reason.trim() !== '' ? { unlockReason: model.unlock_reason.trim() } : {}),
        ...(typeof model.unlock_expires_at === 'string' && model.unlock_expires_at.trim() !== '' ? { unlockExpiresAt: model.unlock_expires_at.trim() } : {}),
        zeroPrice,
        locked,
        ...(rateMultiplier === undefined ? {} : { rateMultiplier }),
      }],
    }
  })
  return { apiVersion: 'freecodego-v1', catalogRevision: typeof value.updated_at === 'string' ? value.updated_at : 'freecodego-bootstrap', generatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), engines: [{ id: 'deepseek', enabled: true, availability: 'available', reasons: [] }, { id: 'codex', enabled: true, availability: 'available', reasons: [] }, { id: 'claude', enabled: true, availability: 'available', reasons: [] }], models: normalized }
}

function parseOrder(value: Record<string, unknown>): FreeCodeGoCheckoutOrder {
  const orderId = value.order_id ?? value.id
  const state = value.status ?? value.state
  if (typeof orderId !== 'number' && typeof orderId !== 'string') throw new Error('FreeCodeGo order_id is required')
  if (typeof state !== 'string' || state.trim() === '') throw new Error('FreeCodeGo order status is required')
  // Absent on every provider that does not echo a settlement currency (see
  // `FreeCodeGoCheckoutOrder.currency`). Rejecting the whole order over a
  // missing *label* discarded a completed backend call: the user payed for a
  // button that never opened, and the order stayed pending and uncancellable
  // because its id never reached the panel. The currency is carried through
  // when present and left unset when not — never invented.
  const currency = typeof value.currency === 'string' && value.currency.trim() !== '' ? value.currency : undefined
  // The checkout URL is handed to a browser/shell opener; only http(s) can be
  // considered safe to open. Anything else (javascript:, custom schemes from
  // a tampered gateway) is dropped rather than relayed to the UI.
  const rawCheckoutUrl = typeof value.pay_url === 'string' ? value.pay_url : typeof value.checkout_url === 'string' ? value.checkout_url : undefined
  let checkoutUrl: string | undefined
  if (rawCheckoutUrl !== undefined && rawCheckoutUrl !== '') {
    try { checkoutUrl = /^https?:$/i.test(new URL(rawCheckoutUrl).protocol) ? rawCheckoutUrl : undefined } catch { checkoutUrl = undefined }
  }
  return {
    orderId: String(orderId),
    state,
    amount: finiteNumber(value.amount, 'amount'),
    ...(currency === undefined ? {} : { currency }),
    ...(checkoutUrl === undefined ? {} : { checkoutUrl }),
    ...(typeof value.qr_code === 'string' && value.qr_code !== '' ? { qrCode: value.qr_code } : {}),
    ...(typeof value.client_secret === 'string' && value.client_secret !== '' ? { clientSecret: value.client_secret } : {}),
    ...(typeof value.out_trade_no === 'string' && value.out_trade_no !== '' ? { outTradeNo: value.out_trade_no } : {}),
    ...(typeof value.pay_amount === 'number' ? { payAmount: value.pay_amount } : {}),
    ...(typeof value.payment_type === 'string' ? { paymentType: value.payment_type } : {}),
    ...(typeof value.expires_at === 'string' ? { expiresAt: value.expires_at } : {}),
    ...(typeof value.entitlement_revision === 'string' ? { entitlementRevision: value.entitlement_revision } : {}),
    ...(typeof value.receipt_available === 'boolean' ? { receiptAvailable: value.receipt_available } : {}),
    ...(typeof value.stripe_receipt_available === 'boolean' ? { stripeReceiptAvailable: value.stripe_receipt_available } : {}),
  }
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`FreeCodeGo ${label} must be a finite number`)
  return value
}

function finiteOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function nonNegativeOptionalNumber(value: unknown): number | undefined {
  const number = finiteOptionalNumber(value)
  return number === undefined || number < 0 ? undefined : number
}

/**
 * The one "this route is free" rule over raw backend rows.
 *
 * Current deployments express a free route as `rate_multiplier: 0`; `access`
 * only ever carries `available`/`locked`, and no pricing block has a `free`
 * mode. The legacy `access: 'free'` / `billing_mode: 'free'` spellings are
 * still honored so an older gateway never renders a free route as a priced
 * one. Pass the option choice plus its pricing blocks; never re-derive this
 * rule at a call site.
 * @param row - the pricing row to classify.
 * @param pricing - the pricing table the row belongs to.
 * @returns true when the row describes a free route.
 */
export function isFreeRouteRow(row: Record<string, unknown>, ...pricing: readonly Record<string, unknown>[]): boolean {
  if (finiteOptionalNumber(row.rate_multiplier) === 0) return true
  return freeAccessFlags(row, ...pricing)
}

/**
 * The same free rule over an already-normalized row. Consumers holding a
 * normalized choice must use this instead of comparing fields themselves.
 * @param route - the route to classify.
 * @returns true when every price the route carries is zero.
 */
export function isZeroPriceRoute(route: { readonly zeroPrice?: boolean; readonly rateMultiplier?: number }): boolean {
  return route.zeroPrice === true || route.rateMultiplier === 0
}

/**
 * Project the backend's `groups[]` into the shape a UI may render.
 *
 * A group without an id or a name cannot label anything, so it is dropped
 * rather than rendered as an unnamed heading. Everything else is optional:
 * an older deployment that omits the array simply yields no groups, and the
 * consumer falls back to whatever signal it has.
 */
function normalizeModelOptionGroups(values: unknown): readonly FreeCodeGoModelOptionGroup[] {
  if (!Array.isArray(values)) return []
  return values.flatMap((candidate) => {
    const group = object(candidate, 'model option group')
    const id = finiteOptionalNumber(group.id)
    const name = typeof group.name === 'string' ? group.name.trim() : ''
    if (id === undefined || name === '') return []
    const text = (field: string): string | undefined => {
      const value = group[field]
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
    }
    const rate = finiteOptionalNumber(group.rate_multiplier)
    const discount = nonNegativeOptionalNumber(group.activity_discount_percent)
    const modelCount = nonNegativeOptionalNumber(group.model_count)
    const sortOrder = finiteOptionalNumber(group.sort_order)
    // Image billing is priced per picture, per group, in three resolution
    // tiers. `0` is a real price here (a free tier), so only a missing or
    // negative field reads as "not configured".
    const imageRateMultiplier = finiteOptionalNumber(group.image_rate_multiplier)
    const imagePrice1K = nonNegativeOptionalNumber(group.image_price_1k)
    const imagePrice2K = nonNegativeOptionalNumber(group.image_price_2k)
    const imagePrice4K = nonNegativeOptionalNumber(group.image_price_4k)
    const access = text('access')
    const unlockRequired = group.unlock_required === true
    const description = text('description')
    const platform = text('platform')
    const protocol = text('protocol')
    const planCode = text('plan_code')
    const unlockReason = text('unlock_reason')
    const unlockExpiresAt = text('unlock_expires_at')
    const activityLabel = text('activity_label')
    return [{
      id,
      name,
      ...(description === undefined ? {} : { description }),
      ...(platform === undefined ? {} : { platform }),
      ...(protocol === undefined ? {} : { protocol }),
      ...(planCode === undefined ? {} : { planCode }),
      // A group is unusable when the backend gates it, so mirror what the
      // per-choice rows report instead of inventing a second lock rule.
      enabled: group.enabled !== false && !isLockedRoute({ ...(access === undefined ? {} : { access }), ...(unlockRequired ? { unlockRequired: true } : {}) }),
      ...(access === undefined ? {} : { access }),
      ...(unlockRequired ? { unlockRequired: true } : {}),
      ...(unlockReason === undefined ? {} : { unlockReason }),
      ...(unlockExpiresAt === undefined ? {} : { unlockExpiresAt }),
      ...(group.default === true ? { default: true } : {}),
      ...(modelCount === undefined ? {} : { modelCount }),
      ...(rate === undefined ? {} : { rateMultiplier: rate }),
      ...(discount === undefined ? {} : { activityDiscountPercent: discount }),
      ...(activityLabel === undefined ? {} : { activityLabel }),
      ...(sortOrder === undefined ? {} : { sortOrder }),
      ...(group.allow_image_generation === undefined ? {} : { allowImageGeneration: group.allow_image_generation === true }),
      ...(group.image_rate_independent === undefined ? {} : { imageRateIndependent: group.image_rate_independent === true }),
      ...(imageRateMultiplier === undefined ? {} : { imageRateMultiplier }),
      ...(imagePrice1K === undefined ? {} : { imagePrice1K }),
      ...(imagePrice2K === undefined ? {} : { imagePrice2K }),
      ...(imagePrice4K === undefined ? {} : { imagePrice4K }),
    }]
  })
}

/**
 * The one "this route is locked for the account" rule.
 *
 * The backend reports an unusable group as `access: 'locked'` **and**
 * `unlock_required: true`; either signal alone means locked, so a partially
 * reported payload cannot leak a locked group into routing or a pin.
 * @param route - the route to classify.
 * @returns true when the route is locked for this account.
 */
export function isLockedRoute(route: { readonly access?: string; readonly unlockRequired?: boolean }): boolean {
  return route.unlockRequired === true || (route.access ?? '').trim().toLowerCase() === 'locked'
}

/** Legacy "this route is free" spellings; see {@link isFreeRouteRow}. */
function freeAccessFlags(...sources: readonly Record<string, unknown>[]): boolean {
  return sources.some((source) => {
    const access = source.access
    const billingMode = source.billing_mode
    return (typeof access === 'string' && access.trim().toLowerCase() === 'free')
      || (typeof billingMode === 'string' && billingMode.trim().toLowerCase() === 'free')
  })
}

function channelMonitorStatus(value: unknown): FreeCodeGoGatewayProviderHealth['status'] {
  return value === 'operational' || value === 'degraded' || value === 'failed' || value === 'error' ? value : 'unknown'
}

function normalizeBaseUrl(value: string, allowInsecureLocalhost: boolean): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('FreeCodeGo baseUrl must be an absolute URL')
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(allowInsecureLocalhost && local && url.protocol === 'http:')) {
    throw new Error('FreeCodeGo baseUrl must use HTTPS')
  }
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url
}

function rejectSecrets(value: unknown, depth = 0): void {
  if (depth > 32) throw new Error('FreeCodeGo catalog exceeds the maximum nesting depth')
  if (Array.isArray(value)) {
    for (const item of value) rejectSecrets(item, depth + 1)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    if (isForbiddenKey(key)) throw new Error(`FreeCodeGo catalog contains forbidden field "${key}"`)
    rejectSecrets(nested, depth + 1)
  }
}

/** Rejects a field when its normalized name is a known secret or looks like one. */
function isForbiddenKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (FORBIDDEN_KEYS.has(normalized)) return true
  if (normalized.includes('privatekey')) return true
  return FORBIDDEN_KEY_SUFFIXES.some(suffix => normalized.endsWith(suffix))
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`FreeCodeGo catalog ${label} must be an object`)
  return value as Record<string, unknown>
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`FreeCodeGo catalog ${label} must be a non-empty string`)
  return value
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`FreeCodeGo catalog ${label} must be an array`)
  return value
}
