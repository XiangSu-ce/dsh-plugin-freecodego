/** Public, redacted types shared by the FreeCodeGo Host RPC and Web client. */

/** Public engine id carried by the FreeCodeGo settings RPC. */
/** Legacy engine ids remain wire-compatible for old snapshots; the UI no
 * longer exposes them and new sessions always use provider `freecodego`. */
export type FreeCodeGoEngineId = 'deepseek' | 'codex' | 'claude' | 'freecodego'

/** Redacted engine state safe to send to a browser client. */
export interface FreeCodeGoEngineSnapshot {
  readonly id: FreeCodeGoEngineId
  readonly generation: number
  readonly availability: 'available' | 'unavailable' | 'updating'
  readonly reasons: readonly string[]
  readonly draining: boolean
  readonly activeLeaseCount: number
}

/** Host-safe state for the optional Codex runtime component. */
export interface FreeCodeGoCodexRuntimeStatus {
  readonly installed: boolean
  readonly platform: string
  readonly runtimeVersion?: string
  readonly artifactDigest?: string
  readonly sourceRevision?: string
  readonly path?: string
  readonly reason?: string
}

/** Host-safe state for the optional Claude Agent SDK runtime component. */
export interface FreeCodeGoClaudeRuntimeStatus {
  readonly installed: boolean
  readonly platform: string
  readonly runtimeVersion?: string
  readonly artifactDigest?: string
  readonly sourceRevision?: string
  readonly path?: string
  readonly reason?: string
}

/** Browser-safe metadata for one official runtime package available to install. */
export interface FreeCodeGoRuntimePackage {
  readonly id: string
  readonly platform: string
  readonly label: string
  readonly runtimeVersion: string
  readonly sourceRevision: string
  readonly installDirectory: string
  readonly compatible: boolean
  readonly source: 'official'
  readonly downloadURL: string
}

/** Account state deliberately limited to data safe for browser Remotes. */
export type FreeCodeGoAccountSnapshot =
  | { readonly status: 'signed-out' | 'reauth-required' | 'backend-not-configured' }
  /** A durable Host credential exists but the identity refresh is retrying. */
  | { readonly status: 'restoring' }
  | { readonly status: 'mfa-required'; readonly emailMasked: string }
  | { readonly status: 'authenticated'; readonly user: { readonly username: string; readonly email: string; readonly avatarUrl?: string; readonly balance: number } }

/**
 * Credentials one FreeCodeGo sign-in attempt sends.
 */
export interface FreeCodeGoLoginRequest {
  readonly email: string
  readonly password: string
  readonly deviceId?: string
  /** Keep the issued session on this machine for later launches (default true). */
  readonly remember?: boolean
  /**
   * Keep the password itself in the Host credential file so the next sign-in
   * form can prefill it. Independent of `remember`: the pair is the session, the
   * password is a convenience the user asks for, and leaving this unset erases a
   * password an earlier attempt stored.
   */
  readonly rememberPassword?: boolean
}

/**
 * Registration details: the sign-in request plus the verification, promo, and invitation codes.
 */
export interface FreeCodeGoRegistrationRequest extends FreeCodeGoLoginRequest {
  readonly verifyCode?: string
  readonly promoCode?: string
  readonly invitationCode?: string
}

/**
 * Federated identity providers the account card offers.
 *
 * The Host answers with `OAUTH_NOT_WIRED:<provider>` until its provider
 * endpoints exist, which is what keeps the buttons live: the card runs the
 * same code path before and after the interface lands, so only the Host gains
 * an `accountOAuthLogin` method and no UI change is needed.
 */
export type FreeCodeGoOAuthProvider = 'google' | 'github'

/**
 * One FreeCodeGo backend read, in the shape the Host and UI report it.
 */
export interface FreeCodeGoBackendSnapshot {
  readonly status: 'available' | 'signed-out' | 'backend-not-configured' | 'error'
  readonly data?: JsonValue
  readonly message?: string
}

/**
 * Time range one token-usage read covers.
 */
export interface TokenUsageRange {
  readonly startAt: number
  readonly endAt: number
  readonly timezone: string
  readonly granularity: 'hour' | 'day'
  readonly provider?: string
  readonly model?: string
  readonly sessionId?: string
}

/**
 * Filters for a locally computed token-usage read.
 */
export interface LocalTokenUsageQuery {
  readonly startAt?: number
  readonly endAt?: number
  readonly granularity?: 'hour' | 'day'
  readonly provider?: string
  readonly model?: string
  readonly sessionId?: string
}

/**
 * Token usage attributed to one provider route.
 */
export interface LocalTokenUsageRoute {
  readonly provider: string
  readonly model: string
  readonly attempts: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly totalTokens: number
  readonly reportedAttempts: number
  readonly partialAttempts: number
  readonly unreportedAttempts: number
  /** Failed request attempts observed on this route (one per llm/retry event). */
  readonly retries: number
  /** Total provider/transport backoff wait accumulated on this route, in ms. */
  readonly retryDelayMs: number
  /** Completed turns attributed to this route; latency samples derive from these. */
  readonly turns: number
  /** Turn wall-clock latency percentiles in ms; undefined until a turn completes. */
  readonly turnLatencyMsP50?: number
  readonly turnLatencyMsP95?: number
}

/** Aggregated provider failure codes observed via llm/retry events. */
export interface LocalTokenUsageFailure {
  readonly provider: string
  readonly code: string
  readonly count: number
}

/**
 * Token usage accumulated over one timeline bucket.
 */
export interface LocalTokenUsageBucket {
  readonly startAt: number
  readonly endAt: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly totalTokens: number
  readonly attempts: number
  readonly unreportedAttempts: number
}

/**
 * One cell of the usage matrix: a date bucket for one route.
 */
export interface LocalTokenUsageMatrixCell {
  readonly date: string
  /** Start of the source timeline bucket; keeps hour-level model series exact. */
  readonly startAt: number
  readonly provider: string
  readonly model: string
  readonly totalTokens?: number
  readonly attempts: number
  readonly status: 'reported' | 'partial' | 'unreported'
}

/**
 * Token usage attributed to one Harness session.
 */
export interface LocalTokenUsageSession {
  readonly sessionId: string
  readonly attempts: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly totalTokens: number
}

/**
 * Prompt-cache waste summary for a range.
 *
 * A large `reportedInputTokens` alone cannot tell growth from waste: the same
 * number is produced by "the work grew" and by "the prefix moved, so every
 * cached token before it was re-billed at full price". This block separates the
 * two and names the cause, because the fixes differ (keep the prefix stable vs.
 * keep the conversation warm vs. stop switching models).
 */
export interface LocalTokenUsageCacheWaste {
  /** Prompt tokens present in the previous request but not read from cache. */
  readonly missedTokens: number
  /** Extra dollars that re-billing caused; 0 when the range has no pricing. */
  readonly missedCostUsd: number
  readonly missCount: number
  /** Turns compared against a predecessor, excluding each session's first. */
  readonly comparedTurns: number
  /** Turns with nothing to compare against, or a provider that never caches. */
  readonly unattributableTurns: number
  /** Compared turns whose cost could be priced; the rest contribute tokens only. */
  readonly pricedTurns: number
  readonly byCause: { readonly idleGap: number; readonly modelChanged: number; readonly prefixChanged: number }
  /** Largest misses, descending, for display. Totals cover every miss. */
  readonly worst: readonly { readonly at: number; readonly model: string; readonly missedTokens: number; readonly missedCostUsd: number; readonly cause: 'idle-gap' | 'model-changed' | 'prefix-changed' }[]
}

/**
 * A whole locally computed token-usage snapshot.
 */
export interface LocalTokenUsageSnapshot {
  readonly source: 'harness-local'
  readonly generatedAt: number
  readonly range: TokenUsageRange
  readonly totals: {
    readonly reportedInputTokens: number
    readonly reportedOutputTokens: number
    readonly reportedCacheReadTokens: number
    readonly reportedCacheWriteTokens: number
    readonly reportedTotalTokens: number
    readonly reportedAttempts: number
    readonly unreportedAttempts: number
    readonly partialAttempts: number
    /** Failed request attempts observed in range (one per llm/retry event). */
    readonly retryCount: number
    /** Total backoff wait across all retries in range, in ms. */
    readonly retryDelayMs: number
    /** Completed-turn wall-clock latency percentiles in ms across all routes. */
    readonly turnLatencyMsP50?: number
    readonly turnLatencyMsP95?: number
    /** Top provider failure codes by count, descending. */
    readonly failures: readonly LocalTokenUsageFailure[]
    /**
     * Prompt-cache waste, when any turn was attributable. Absent — not zero —
     * when the range never reported cache activity, so a provider we cannot see
     * does not read as a provider that wasted nothing.
     */
    readonly cacheWaste?: LocalTokenUsageCacheWaste
  }
  readonly routes: readonly LocalTokenUsageRoute[]
  readonly timeline: readonly LocalTokenUsageBucket[]
  readonly matrix: readonly LocalTokenUsageMatrixCell[]
  readonly currentSession?: LocalTokenUsageSession
}

/**
 * Usage figures the FreeCodeGo gateway reported back.
 */
export interface GatewayUsageSnapshot {
  readonly source: 'freecodego-gateway'
  readonly fetchedAt: number
  readonly days: number
  readonly status: 'available' | 'signed-out' | 'backend-not-configured' | 'error'
  readonly summary?: JsonValue
  readonly models: readonly JsonValue[]
  readonly timeline: readonly JsonValue[]
  readonly insights?: JsonValue
  readonly charges?: readonly JsonValue[]
  readonly turns?: readonly JsonValue[]
  /**
   * The usage endpoint's own rollup of the window.
   *
   * `turns` is a bounded sample of the newest requests, so it cannot total a
   * 90-day window. These three carry the complete per-day, per-window, and
   * per-thread figures the same endpoint computes from the settled summaries,
   * which is what the gateway page's trend and window cards have to total.
   * Dropping them is what made the page report less than the local Harness tab
   * for the same traffic.
   */
  readonly dailyTrend?: readonly JsonValue[]
  readonly windows?: readonly JsonValue[]
  readonly threads?: readonly JsonValue[]
  /** Which aggregation the endpoint served from, when it says so. */
  readonly aggregationSource?: string
  readonly message?: string
}

/**
 * Any JSON-serializable value, as the backend returns it.
 */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue }

/** Browser-safe community registry row. Package sources are validated by Host. */
export interface CommunityCatalogPlugin {
  readonly name: string
  readonly owner: string
  readonly url: string
  readonly category: string | readonly string[]
  /** Validated catalog-provided artwork. Missing artwork is left blank rather than synthesized. */
  readonly iconUrl?: string
  /** Author-maintained plugin visuals published by the community catalog. */
  readonly screenshots?: readonly string[]
  readonly description?: { readonly zh?: string; readonly en?: string }
  readonly npm?: string
  readonly stars?: number
  readonly downloads?: number
  readonly added?: string
}

/**
 * One purchasable plan, as the payment surface lists it.
 */
export interface FreeCodeGoPaymentPlan {
  readonly id: string | number
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

/** Browser-safe payment channel from the existing FreeCodeGo payment API. */
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

/**
 * One resolution tier of an image-billing model: the price of one picture.
 *
 * The backend settles a generation request per generated image, using the
 * group's `image_price_1k/2k/4k`, so these are the only numbers that describe
 * what such a model actually costs. They cannot be folded into the token
 * columns: those are priced per million tokens the charge never reads.
 */
export interface FreeCodeGoImagePriceTier {
  /** The backend's own tier label, kept verbatim (`1K` / `2K` / `4K`). */
  readonly label: string
  /** Effective price per generated image, the image rate already applied. */
  readonly price: number
  /** The group's configured unit price before the image rate. Present only
   * when it differs from {@link price}, so no strike-through is invented for a
   * row that carries no discount. */
  readonly originalPrice?: number
}

/** Effective public price for one model and one backend gateway group. */
export interface FreeCodeGoGatewayModelPrice {
  readonly modelId: string
  readonly displayName: string
  readonly provider: string
  readonly source: 'gateway' | 'empero' | 'opencode' | 'openrouter' | 'logfare' | 'workbuddy' | 'agnes' | 'sensenova' | 'nvidia' | 'vyce'
  readonly groupName: string
  readonly platform?: string
  readonly rateMultiplier: number
  readonly billingMode: 'token' | 'per-request' | 'image'
  readonly currency: string
  readonly description?: string
  readonly originalInputPricePerMillion?: number
  readonly originalOutputPricePerMillion?: number
  readonly originalCacheReadPricePerMillion?: number
  readonly originalCacheWritePricePerMillion?: number
  readonly originalPerRequestPrice?: number
  /** Catalog price per million image-output tokens, for a model that still
   * reports image tokens. Distinct from {@link imagePrices}. */
  readonly originalImageOutputPricePerMillion?: number
  readonly inputPricePerMillion?: number
  readonly outputPricePerMillion?: number
  readonly cacheReadPricePerMillion?: number
  readonly cacheWritePricePerMillion?: number
  readonly perRequestPrice?: number
  readonly imageOutputPricePerMillion?: number
  /** Per-image tiers from the row's backend group, in the row's currency. An
   * empty or absent list is a price the backend did not quote, never a free
   * one. */
  readonly imagePrices?: readonly FreeCodeGoImagePriceTier[]
}

/**
 * One payment order and its current state.
 */
export interface FreeCodeGoPaymentOrder {
  readonly orderId: string
  readonly state: string
  readonly amount: number
  /** Settlement currency of {@link payAmount}, and **optional on purpose**:
   * the create-order response passes the payment provider's currency through
   * only when the provider reported one, so orders created through Alipay or
   * WeChat arrive without it. Absent means "not stated", never "USD" — the
   * settings panel resolves the real currency from the channel the order names,
   * and a consumer that needs one must do the same instead of assuming. */
  readonly currency?: string
  readonly checkoutUrl?: string
  readonly qrCode?: string
  readonly clientSecret?: string
  readonly outTradeNo?: string
  readonly payAmount?: number
  readonly paymentType?: string
  readonly expiresAt?: string
  readonly entitlementRevision?: string
}

/**
 * Desktop checkout configuration as the browser may see it.
 *
 * Mirrors `FreeCodeGoDesktopPaymentConfig` in the API client. Two fields are the
 * reason this reader exists at all:
 *
 * - `stripePublishableKey` — Stripe's own client key, which is what lets the
 *   card form run inside the plugin. It is publishable by design; the secret key
 *   never crosses this boundary, and the API read rejects secret-shaped fields
 *   outright.
 * - the limit/multiplier/fee fields — the only producer of the account's real
 *   per-order range. `checkout-info`'s channel rows can report `single_min` and
 *   `single_max` as `0`, which is an absent limit rather than a zero-width one.
 */
export interface FreeCodeGoPaymentConfig {
  readonly paymentEnabled: boolean
  readonly minAmount?: number
  readonly maxAmount?: number
  readonly dailyLimit?: number
  readonly orderTimeoutMinutes?: number
  readonly maxPendingOrders?: number
  readonly enabledPaymentTypes: readonly string[]
  readonly balanceDisabled?: boolean
  readonly balanceRechargeMultiplier?: number
  readonly rechargeFeeRate?: number
  readonly helpText?: string
  readonly helpImageUrl?: string
  readonly stripePublishableKey?: string
  readonly paypalClientId?: string
}

/**
 * One selectable route of a managed model.
 *
 * The group fields are populated from `/models/options` whenever the account has
 * them; they are what the picker and the Settings pin read. `locked` and
 * `zeroPrice` are derived once in the API client and carried through unchanged.
 */
export interface FreeCodeGoManagedCatalogChoice {
  readonly routeKey: string
  readonly label: string
  readonly availability: string
  readonly compatibleEngines: readonly string[]
  readonly groupId?: number
  readonly groupName?: string
  readonly protocol?: string
  readonly access?: string
  readonly unlockRequired?: boolean
  readonly unlockReason?: string
  readonly unlockExpiresAt?: string
  readonly zeroPrice?: boolean
  readonly locked?: boolean
  readonly rateMultiplier?: number
}

/**
 * One account group the picker lists models under.
 *
 * These come straight from the backend's `/models/options` `groups[]`: the name
 * is the heading a user reads, `sortOrder` is the order the backend wants, and
 * `rateMultiplier` is already the account's effective rate. The picker uses
 * them so a model is never labelled with an internal route key or with the
 * vendor it happens to belong to.
 */
export interface FreeCodeGoManagedCatalogGroup {
  readonly id: number
  readonly name: string
  readonly enabled: boolean
  /** The account's default group, as the backend declares it. This is the only
   * authority for "which group serves when the user picked none" — the Host no
   * longer ranks groups by price itself (see `selectModelOptionChoice`). */
  readonly default?: true
  readonly description?: string
  readonly platform?: string
  readonly protocol?: string
  /** `0` means free; absent means the backend published no rate. */
  readonly rateMultiplier?: number
  readonly activityLabel?: string
  readonly unlockReason?: string
  readonly unlockExpiresAt?: string
  readonly sortOrder?: number
}

/** Redacted managed model directory from the existing FreeCodeGo bootstrap route. */
export interface FreeCodeGoManagedCatalog {
  readonly catalogRevision: string
  /** Account groups, in backend order. Absent on catalogs cached before the
   * backend published them, and for providers that have no gateway groups. */
  readonly groups?: readonly FreeCodeGoManagedCatalogGroup[]
  readonly models: readonly {
    readonly id: string
    readonly displayName: string
    readonly provider: string
    readonly protocol: string
    readonly availability: string
    readonly compatibleEngines: readonly string[]
    readonly choices: readonly FreeCodeGoManagedCatalogChoice[]
  }[]
}

/**
 * One browser-safe desktop device session.
 *
 * Device ids are not credentials — they only name a session the account already
 * owns — but nothing token-shaped is carried here either.
 */
export interface FreeCodeGoDeviceSessionRow {
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

/** Browser-safe device-session listing for the Settings page. */
export interface FreeCodeGoDeviceSessions {
  readonly currentDeviceId?: string
  readonly sessions: readonly FreeCodeGoDeviceSessionRow[]
}

/** Browser-safe model availability fact used by the private model picker. */
export interface FreeCodeGoModelAvailability {
  readonly provider: string
  readonly model: string
  readonly available: boolean
  readonly reason?: string
}

/** Browser-safe WorkBuddy account row; token and refresh token are Host-only. */
export interface WorkBuddyAccountSnapshot {
  readonly uid: string
  readonly nickname?: string
  readonly domain?: string
  readonly expiresAt: number
  readonly status: 'authenticated' | 'reauth-required' | 'cooling'
  readonly cooldownUntil?: number
  readonly quota?: { readonly remain: number; readonly used: number; readonly size: number; readonly packages: number }
  readonly quotaError?: string
}

/** Browser-safe WorkBuddy login state; token and refresh token are Host-only. */
export type WorkBuddyStatus =
  | { readonly status: 'signed-out'; readonly accounts: readonly WorkBuddyAccountSnapshot[] }
  | { readonly status: 'login-pending'; readonly accounts: readonly WorkBuddyAccountSnapshot[] }
  | { readonly status: 'reauth-required'; readonly uid?: string; readonly nickname?: string; readonly accounts: readonly WorkBuddyAccountSnapshot[] }
  | { readonly status: 'authenticated'; readonly uid: string; readonly nickname?: string; readonly enterpriseId?: string; readonly domain?: string; readonly expiresAt: number; readonly accounts: readonly WorkBuddyAccountSnapshot[] }

/** Dynamic WorkBuddy model metadata returned by the authenticated model endpoint. */
export interface WorkBuddyModel {
  readonly id: string
  readonly name: string
  readonly contextWindow?: number
  readonly maxTokens?: number
}

// ============================================================================
// WorkBuddy International Edition (workbuddy.ai) Types
// ============================================================================

/** WorkBuddy International account info for display in the status list. */
export interface WorkBuddyInternationalAccountInfo {
  readonly id: string
  readonly email?: string
  readonly apiKeyConfigured: boolean
  /** Credit position, or the upstream reason it could not be read. */
  readonly credits?: {
    readonly total: number
    readonly remaining: number
    readonly used: number
    /** Soonest expiry among packages that still hold credits. */
    readonly soonestExpireAt?: number
    readonly expiringSoon: boolean
    readonly expired: boolean
    readonly checkedAt: number
    readonly error?: string
  }
}

/** Remaining credits of one WorkBuddy resource package. */
export interface WorkBuddyCreditPackage {
  readonly packageCode?: string
  readonly packageName?: string
  readonly total: number
  readonly remaining: number
  readonly used: number
  /** Epoch ms the package's remaining credits expire, when upstream states one. */
  readonly expireAt?: number
  readonly expiringSoon: boolean
  readonly expired: boolean
}

/** One account's aggregated credit position. */
export interface WorkBuddyCredits {
  readonly total: number
  readonly remaining: number
  readonly used: number
  /** The soonest expiry among packages that still hold credits. */
  readonly soonestExpireAt?: number
  readonly expiringSoon: boolean
  readonly expired: boolean
  readonly packages: readonly WorkBuddyCreditPackage[]
  readonly checkedAt: number
  /** Upstream's own reason when the query could not be answered. */
  readonly error?: string
}

/** WorkBuddy International account state - multiple accounts supported */
export interface WorkBuddyInternationalAccount {
  readonly id: string
  readonly nickname?: string
  readonly accessToken: string
  readonly refreshToken?: string
  readonly expiresAt: number
  readonly creditTotal: number
  readonly lastChecked: number
  readonly email?: string
  /**
   * The account's WorkBuddy uid, exactly as the credential source spelled it.
   *
   * The product host routes chat by `X-User-Id`, and an email is not a uid: an
   * account whose uid was replaced by its address is routed as an unknown
   * identity. Absent means the credential source never stated one, which the
   * request declares with `X-No-User-Id` rather than guessing.
   */
  readonly uid?: string
  /**
   * The login domain (`workbuddy.ai` for the international product).
   *
   * Sent as `X-Domain`; the host rejects the department-less accounts without
   * it as often as it rejects mismatched ones, so it rides along whenever the
   * credential source recorded it.
   */
  readonly domain?: string
  /** Enterprise/tenant id, when the sign-in belongs to one. */
  readonly enterpriseId?: string
  /** Last credit snapshot, so the card renders without a fresh query. */
  readonly creditRemaining?: number
  readonly creditUsed?: number
  readonly creditExpiresAt?: number
  readonly creditCheckedAt?: number
  readonly creditExpiringSoon?: boolean
  readonly creditError?: string
}

/** Browser-safe WorkBuddy International status for UI display */
export interface WorkBuddyInternationalStatus {
  readonly configured: boolean
  readonly activeAccountId?: string
  readonly accounts: readonly WorkBuddyInternationalAccountInfo[]
  readonly freeModels: readonly WorkBuddyInternationalModel[]
  /** A credit sweep is running right now. */
  readonly sweepInProgress?: boolean
}

/** WorkBuddy International model with full billing and reasoning info */
export interface WorkBuddyInternationalModel {
  readonly id: string
  readonly displayName: string
  readonly provider: string
  readonly contextWindow?: number
  readonly maxTokens?: number
  readonly supportsImages: boolean
  readonly rateMultiplier: number
  readonly billing?: {
    credits?: string
    badges?: readonly string[]
    free: boolean
  }
  readonly reasoning?: {
    supports: boolean
    onlyReasoning: boolean
    supportedEfforts?: readonly ('low' | 'medium' | 'high' | 'xhigh' | 'max')[]
    defaultEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    canDisableThinking: boolean
  }
}

/** Request to add a WorkBuddy International account */
export interface WorkBuddyInternationalLoginRequest {
  readonly email: string
  readonly password: string
}

/** A WorkBuddy International browser-authorization ticket the Settings page renders and polls. */
export interface WorkBuddyBrowserLogin {
  /**
   * The state the product issued for this attempt; the poll key.
   *
   * Server-minted on purpose: the browser step records the tokens under it, so
   * a state the client invents can never be polled to a result.
   */
  readonly state: string
  /**
   * The `authUrl` the product issued for {@link state}; it 302s into the
   * identity provider (OneID/WeChat/Google/GitHub) with that state attached.
   */
  readonly loginUrl: string
  readonly expiresAt: number
  /**
   * Set when the Host could not hand the URL to the system browser.
   *
   * The authorization itself is unaffected — the ticket is still valid and the
   * card still renders the link — so this only tells the page to stop claiming
   * a browser it never opened and point at the link instead.
   */
  readonly note?: 'BROWSER_OPEN_FAILED'
}

/** Result of one WorkBuddy authorization poll. `pending` means "keep polling". */
export type WorkBuddyLoginPoll =
  | { readonly pending: true }
  | { readonly pending: false; readonly state: WorkBuddyInternationalStatus }

// ============================================================================
// Qoder connector types
// ============================================================================

/** One Qoder quota bucket, as the card renders it. */
export interface QoderQuotaBucketInfo {
  readonly used: number
  readonly total: number
  readonly remaining: number
  readonly resetTime?: string
}

/** One Qoder account's quota position, or the reason it could not be read. */
export interface QoderQuotaInfo {
  readonly plan?: string
  readonly userQuota?: QoderQuotaBucketInfo
  readonly addonQuota?: QoderQuotaBucketInfo
  readonly isQuotaExceeded: boolean
  readonly expiresAt?: number
  readonly checkedAt: number
  readonly error?: string
}

/** Browser-safe Qoder account row; device and refresh tokens are Host-only. */
export interface QoderAccountInfo {
  readonly id: string
  readonly name?: string
  readonly email?: string
  readonly plan?: string
  readonly region: 'global' | 'cn'
  readonly quota?: QoderQuotaInfo
}

/** One Qoder route, free or metered. */
export interface QoderModelInfo {
  readonly id: string
  readonly displayName: string
  readonly contextWindow?: number
  readonly maxTokens?: number
  readonly isReasoning: boolean
  /**
   * The directory's own price multiplier for this route, when it states one.
   *
   * `0` is the free tier, above it is what the route costs; absent means the
   * directory did not price it, which the picker treats as unpriced rather than
   * free. Carried through the browser-safe row because the settings checklist
   * decides whether a row starts shown from exactly this value.
   */
  readonly priceFactor?: number
}

/** Browser-safe Qoder status for the settings card. */
export interface QoderStatus {
  readonly configured: boolean
  readonly activeAccountId?: string
  readonly accounts: readonly QoderAccountInfo[]
  readonly freeModels: readonly QoderModelInfo[]
}

/** A Qoder browser-authorization ticket the Settings page renders and polls. */
export interface QoderBrowserLogin {
  readonly state: string
  readonly loginUrl: string
  readonly expiresAt: number
  /** Set when the Host could not hand the URL to the system browser. */
  readonly note?: 'BROWSER_OPEN_FAILED'
}

/** Result of one Qoder authorization poll. `pending` means "keep polling". */
export type QoderLoginPoll =
  | { readonly pending: true }
  | { readonly pending: false; readonly state: QoderStatus }

/**
 * Browser-safe Trae account row; Cloud-IDE JWTs stay in the Host vault.
 *
 * The label is what the card names the row by, and it is derived Host-side
 * because the only name the upstream supplies is the account's own display name
 * from the sign-in redirect — a value whose encoding needs repairing, which is
 * not a browser's job.
 */
export interface TraeAccountSnapshot {
  readonly id: string
  readonly label: string
  /** Which deployment this account belongs to; the card groups the pool by it. */
  readonly realm: 'cn' | 'sg'
  readonly userId?: string
  readonly expiresAt?: number
  readonly status: 'authenticated' | 'reauth-required'
}

/**
 * Browser-safe Trae authorization and account state.
 *
 * One value describes both halves of the connector — which accounts are signed
 * in, and whether a sign-in is in flight — because the settings card renders
 * both at once: the pool stays visible under an in-progress authorization, and
 * a poll that answers "still pending" is the same question as "who is signed
 * in" asked one tick later.
 *
 * `loginUrl` is carried on the pending variant because the browser may not have
 * opened (`note: 'BROWSER_OPEN_FAILED'`), and because a loopback redirect is
 * never guaranteed to arrive — when it does not, the user has the page's own URL
 * and can paste the callback it produced (`traeSubmitCallback`).
 */
export type TraeStatus =
  | { readonly status: 'signed-out'; readonly accounts: readonly TraeAccountSnapshot[] }
  | {
    readonly status: 'login-pending'
    readonly accounts: readonly TraeAccountSnapshot[]
    /** The deployment the browser is being authorized against. */
    readonly realm: 'cn' | 'sg'
    readonly loginUrl?: string
    /** Epoch ms after which the attempt is abandoned. */
    readonly loginExpiresAt?: number
    readonly note?: 'BROWSER_OPEN_FAILED'
  }
  | { readonly status: 'reauth-required'; readonly accountId?: string; readonly label?: string; readonly accounts: readonly TraeAccountSnapshot[] }
  | { readonly status: 'authenticated'; readonly accountId: string; readonly label: string; readonly accounts: readonly TraeAccountSnapshot[] }

/** Trae raw-chat model directory entry. */
export interface TraeModel {
  readonly id: string
  readonly name: string
  /**
   * The deployment whose catalog lists it.
   *
   * Carried because the two catalogs are almost disjoint and a model name sent to
   * the wrong one answers `4001 param is invalid` — so "which realm serves this"
   * is a routing fact the pool needs, not a label.
   */
  readonly realm: 'cn' | 'sg'
  readonly contextWindow?: number
  readonly maxTokens?: number
}

/**
 * What one provider's daily check-in achieved for one account.
 *
 * `already` is a success: today's credits are on the account, and asking again
 * would spend a request only to be told the same thing. `unavailable` is the
 * provider saying the campaign is not running — that is upstream's own answer
 * rather than a failure of ours, and the card should say so instead of raising
 * an error over a feature that is simply switched off.
 */
export type FreeCodeGoCheckinOutcome = 'claimed' | 'already' | 'unavailable' | 'failed'

/** One account's line inside a check-in report. */
export interface FreeCodeGoCheckinAccount {
  readonly accountId: string
  readonly label: string
  readonly outcome: FreeCodeGoCheckinOutcome
  /** What this account collected on this run; `0` for every other outcome. */
  readonly credits: number
  /** Upstream's own words, when the line needs explaining. */
  readonly message?: string
  /**
   * What upstream refused, when this account collected *some* of its benefits.
   *
   * A field rather than a sentence inside {@link message}: a run can collect one
   * campaign and be refused another, and the card renders the collected part from
   * `credits`, so a refusal that only exists inside the prose would never be shown
   * to anyone — the exact shape of failure that looks like a clean success.
   */
  readonly refused?: string
}

/**
 * One check-in run across every account of one provider.
 *
 * Reported as a run rather than per account because the gesture is one gesture —
 * "check in my Trae accounts" — while the per-account lines are what let the
 * card name the account that failed instead of only reporting that one did.
 */
export interface FreeCodeGoCheckinReport {
  /** Epoch ms this run finished. */
  readonly checkedAt: number
  /** Everything this run collected, across all accounts. */
  readonly credits: number
  readonly accounts: readonly FreeCodeGoCheckinAccount[]
}

/**
 * One Z.ai quota window and how much of it remains.
 */
export interface ZaiQuota { readonly name: string; readonly total?: number; readonly used?: number; readonly remaining?: number; readonly expiresAt?: number | string }
/**
 * Z.ai account state, as the settings surface reports it.
 */
export interface ZaiAccountSnapshot { readonly id: string; readonly label: string; readonly status: 'authenticated' | 'reauth-required'; readonly plan?: string; readonly quotas?: readonly ZaiQuota[]; readonly quotaError?: string; readonly lastCheckedAt?: number }
/**
 * Sign-in state of the Z.ai account, in the shape the settings surface renders.
 */
export type ZaiStatus = { readonly status: 'signed-out' | 'login-pending' | 'authenticated'; readonly accounts: readonly ZaiAccountSnapshot[]; readonly activeAccountId?: string }
/**
 * Promotion Z.ai reported for the signed-in account.
 */
export interface ZaiPromotionInfo { readonly modelId: 'glm-5.3-flash'; readonly eligible: boolean; readonly active: boolean; readonly cutoffDay: 20; readonly window: '23:00-09:00 Asia/Shanghai'; readonly message: string }
/**
 * One model the Z.ai account can run.
 */
export interface ZaiModel { readonly id: string; readonly name: string; readonly contextWindow?: number; readonly maxTokens?: number; readonly promotion?: ZaiPromotionInfo }

/** Browser-safe SenseNova API-key state; the key itself never leaves Host.
 *
 * No model count: the only honest source is SenseNova's live `/models`, which
 * the picker already reads. The field this replaced was a literal sum of two
 * hardcoded rosters, so it reported the same number whether the account was
 * connected, empty, or upstream was down. */
export interface FreeCodeGoSenseNovaStatus {
  readonly configured: boolean
  readonly baseUrl: string
}

/**
 * NVIDIA account state, as the settings surface reports it.
 */
export interface FreeCodeGoNvidiaStatus {
  readonly configured: boolean
  readonly baseUrl: string
}

/** Browser-safe VyceAI projection; the API key stays in the Host vault.
 *
 * The model names travel with the status so the settings card may only
 * advertise what the adapter actually serves. */
export interface FreeCodeGoVyceStatus {
  readonly configured: boolean
  readonly models: readonly { readonly id: string; readonly name: string }[]
}

/** Browser-safe Logfare account projection; the API key and session stay in the Host vault.
 *
 * The model *names* travel with the counts because `logfareStatus()` already
 * resolves the live directory to compute them — the settings panel can label
 * the routes it is describing without a second request, and without a
 * hand-maintained roster that drifts the moment logfare rotates its catalogue. */
export interface FreeCodeGoLogfareStatus {
  readonly configured: boolean
  readonly sessionConfigured: boolean
  readonly trainingOptIn: boolean
  readonly premiumUnlocked: boolean
  readonly standardModelCount: number
  readonly premiumModelCount: number
  readonly standardModelNames: readonly string[]
  readonly premiumModelNames: readonly string[]
}

/** Explicit confirmations required before the Host creates a Logfare account. */
export interface FreeCodeGoLogfareRegistrationRequest {
  readonly username: string
  readonly password: string
  readonly tosAccepted: boolean
  readonly ageConfirmed: boolean
  readonly trainingOptIn: boolean
}

/**
 * Account state the Agnes client reports to the settings surface.
 */
export type AgnesStatus =
  | { readonly status: 'signed-out'; readonly accounts: readonly [] }
  | { readonly status: 'authenticated'; readonly accounts: readonly { readonly id: string; readonly email?: string; readonly username?: string; readonly apiKeyConfigured: boolean; /** The platform rejected this account's session; it is kept, not used. */ readonly reauthRequired?: boolean }[]; readonly activeAccountId?: string; readonly email?: string; readonly username?: string; readonly apiKeyConfigured: boolean }

// ============================================================================
// Cline (api.cline.bot) Types
// ============================================================================

/** One free route of a Cline account that ran out of budget, and until when. */
export interface ClineModelCooldown {
  readonly model: string
  readonly until: number
}

/**
 * One Cline account row. Tokens stay in the Host vault: the browser only needs
 * enough to tell accounts apart and to explain why one cannot serve a request.
 *
 * `status` describes the account, not its routes: Cline's free promotions are
 * budgeted per model, so a capped model parks that route (`coolingModels`) while
 * the account itself stays `active` and keeps serving everything else.
 */
export interface ClineAccountInfo {
  readonly id: string
  readonly email?: string
  readonly status: 'active' | 'cooling' | 'reauth-required'
  readonly cooldownUntil?: number
  /** Routes this account is parked on while its other routes still serve. */
  readonly coolingModels?: readonly ClineModelCooldown[]
  readonly expiresAt?: number
  readonly note?: string
}

/** One free route from Cline's live `recommended-models` feed. */
export interface ClineFreeModel {
  readonly id: string
  readonly name: string
  readonly provider: string
  readonly description?: string
  readonly tags?: readonly string[]
}

/** Browser-safe Cline state: the account pool plus the live free directory. */
export type ClineStatus =
  | { readonly status: 'signed-out'; readonly accounts: readonly []; readonly freeModels: readonly ClineFreeModel[] }
  | { readonly status: 'authenticated'; readonly accounts: readonly ClineAccountInfo[]; readonly activeAccountId?: string; readonly email?: string; readonly freeModels: readonly ClineFreeModel[]; readonly usage?: ClineUsage }

/** One usage window from Cline's plan usage-limits feed. */
export interface ClineUsageWindow {
  /** Stable window key, e.g. `five-hour` / `weekly` / `monthly`. */
  readonly id: string
  /** Consumed share in percent (0-100) when the upstream reports it. */
  readonly usedPercent?: number
  readonly used?: number
  readonly limit?: number
  /** Epoch ms when the window resets, when the upstream reports it. */
  readonly resetsAt?: number
}

/** Browser-safe usage and quota snapshot for the Cline account pool. */
export interface ClineUsage {
  readonly windows: readonly ClineUsageWindow[]
  /** Pay-as-you-go credit balance in US dollars, when the upstream reports one. */
  readonly balanceUsd?: number
  /** Plan tier name, when the usage payload carries one. */
  readonly plan?: string
}

/** A WorkOS device-login ticket the Settings page renders and polls. */
export interface ClineDeviceLogin {
  readonly deviceCode: string
  readonly userCode: string
  readonly verificationUrl: string
  readonly intervalSeconds: number
  readonly expiresAt: number
}

/** Result of one device-login poll. `pending` means "keep polling". */
export interface ClineLoginPoll {
  readonly pending: boolean
  readonly state?: ClineStatus
}
/** One persisted third-party MCP server definition. */
export interface FreeCodeGoMcpServer {
  readonly id: string
  readonly enabled: boolean
  readonly transport: 'stdio' | 'streamable-http'
  readonly serverName: string
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
}

/** One extra filesystem root supplied to the shared Skill registry. */
export interface FreeCodeGoSkillRoot {
  readonly id: string
  readonly enabled: boolean
  readonly path: string
}

/** Persisted feature switches and managed extension definitions. */
export interface FreeCodeGoCapabilitySettings {
  readonly mcpEnabled: boolean
  readonly skillEnabled: boolean
  readonly voiceInputEnabled: boolean
  readonly sessionDeleteEnabled: boolean
  /** Explicit category overrides keyed as `${provider}\u0000${model}`. */
  readonly modelCategories: Readonly<Record<string, FreeCodeGoModelCategory>>
  readonly mcpServers: readonly FreeCodeGoMcpServer[]
  readonly skillRoots: readonly FreeCodeGoSkillRoot[]
  /**
   * Per-Skill model-invocation overrides, keyed by Skill name.
   *
   * A Skill's own file states whether the model may auto-invoke it
   * (`disable-model-invocation`), and that declaration is the default here. A
   * key present in this map is the *user's* answer instead — `true` hands the
   * Skill to the model, `false` keeps it manual-only — and deleting the key
   * restores the file. The preference lives in settings, never in the Skill
   * file, so a third-party Skill can be updated without losing it.
   */
  readonly skillInvocationOverrides: Readonly<Record<string, boolean>>
  /**
   * Where a Skill install should land by default, as the two axes of the
   * placement table (`skills/placement.ts`).
   *
   * The *choice* is stored, never the path it resolves to. A root is derived from
   * the folder this Host runs in, `$DSH_HOME` and the home directory, and every one
   * of those can move under a saved string — a stored path would then name a
   * directory the user never picked, which is the failure the placement table exists
   * to make visible. Absent means no preference: an install goes to the Marketplace's
   * own community root, exactly as it did before placements existed.
   *
   * `null` is the explicit "none" a clear writes, and it exists because a settings write
   * is a merge: an omitted field means "no change to what is stored", which would leave a
   * cleared preference in place. Readers never see it — `copySettings` (and so every
   * snapshot) reports the same absence for both spellings.
   */
  readonly preferredSkillPlacement?: FreeCodeGoSkillPlacement | null
}

/** A model capability classification used by the plugin UI and media tools. */
export type FreeCodeGoModelCategory = 'text' | 'image' | 'video' | 'audio'

/**
 * One discovered Skill as the settings library lists it.
 *
 * The list is the *user-facing* inventory, so it deliberately keeps skills the
 * model may not auto-invoke: `disable-model-invocation` removes a skill from the
 * model's reach, not the user's, and those are exactly the entries a human has
 * to find by reading this page. Consumers that speak for the model (the Claude
 * bridge `skill/list`, subagent projection) must keep filtering on
 * {@link modelInvocable} themselves.
 */
export interface FreeCodeGoSkillEntry {
  readonly name: string
  readonly description: string
  readonly source: string
  /** Whether model-facing catalogs may advertise and load this Skill. */
  readonly modelInvocable: boolean
  /** Whether a human may invoke this Skill by name. */
  readonly userInvocable: boolean
}

/** One file that sits beside a Skill's `SKILL.md`. */
export interface FreeCodeGoSkillFile {
  /** Slash-separated path relative to the Skill directory. */
  readonly path: string
  readonly bytes: number
}

/** Request for one discovered Skill's body, or for one of its companion files. */
export interface FreeCodeGoSkillDetailRequest {
  readonly name: string
  /** Omit for the `SKILL.md` body; name a listed companion file to read that instead. */
  readonly file?: string
}

/**
 * One Skill a thin alias body forwards to, resolved so the dialog can show it.
 *
 * `grill-me` is the motivating case: a user-invocable name whose body is one
 * line pointing at `grilling`, where the actual prompt lives.
 */
export interface FreeCodeGoSkillForward {
  readonly name: string
  readonly description: string
  /** The forwarded Skill's own `SKILL.md` body. */
  readonly content: string
}

/** Browser-safe detail for one discovered Skill, loaded on demand. */
export interface FreeCodeGoSkillDetail extends FreeCodeGoSkillEntry {
  /** The `SKILL.md` body, or the requested companion file when `file` was given. */
  readonly content: string
  /** Companion files in the Skill directory, `SKILL.md` excluded. */
  readonly files: readonly FreeCodeGoSkillFile[]
  /**
   * Skills this Skill's whole body forwards to; empty for every ordinary Skill.
   *
   * Only populated for the `SKILL.md` body read, never for a companion file:
   * a sibling file is the caller's explicit request and needs no context.
   */
  readonly forwarded: readonly FreeCodeGoSkillForward[]
  /** The companion file that was requested, when one was. */
  readonly file?: { readonly path: string; readonly bytes: number; readonly content: string }
}

/** Browser-safe extension inventory returned by the FreeCodeGo Host Remote. */
export interface FreeCodeGoCapabilitySnapshot extends FreeCodeGoCapabilitySettings {
  readonly mcpTools: readonly { readonly name: string; readonly description: string }[]
  readonly skills: readonly FreeCodeGoSkillEntry[]
  /** Provider mounts that failed during the last reconcile; omitted when every mount succeeded. */
  readonly mountErrors?: readonly { readonly id: string; readonly message: string }[]
  /**
   * Entries the folder-trust gate refused to mount, with the reason.
   *
   * Reported separately from {@link mountErrors} because the two ask different
   * things of the user: a mount error is something to retry, a refusal is
   * something to grant or accept. Folding them together would turn "this
   * repository is untrusted" into an unexplained failure, which is exactly the
   * silent skip the gate must never produce.
   */
  readonly trustRefusals?: readonly { readonly id: string; readonly message: string }[]
  /**
   * What the last Skill install recorded, on the snapshot that install returned.
   *
   * Present because "installed" is only checkable if the pin is visible: the
   * commit, whether the lockfile took the record, and every verification failure
   * over the root afterwards. Absent on every other snapshot — a settings read has
   * no install to report, and a fabricated one would look like a Skill landed
   * when nothing was fetched.
   */
  readonly skillInstall?: FreeCodeGoSkillInstallReport
  readonly skillRemove?: FreeCodeGoSkillRemoveReport
}

/**
 * What one Skill removal took away, as the settings surface reads it.
 *
 * Declared here for the same reason the install report is: this module is the
 * package's `./types` face, which the client loads, and importing the host module
 * that performs the removal would pull `node:fs` into the browser bundle.
 */
export interface FreeCodeGoSkillRemoveReport {
  /** The name the removed Skill was known by — the one inside its `SKILL.md`. */
  readonly name: string
  /** The directory that went away; the same as the name for a recorded Skill. */
  readonly directory: string
  /** The source the record carried, when the Skill was recorded at all. */
  readonly source?: string
  /** False when the directory existed with no record, so nothing identified it. */
  readonly recorded: boolean
  /** Which of the directory and the record were removed, in the installer's words. */
  readonly detail: string
  /** Every remaining Skill in the root that no longer matches the record. */
  readonly verification: readonly { readonly name: string; readonly reason: string; readonly path?: string }[]
}

/**
 * What one Skill install recorded, as the settings surface reads it.
 *
 * Declared here rather than imported from `skills/marketplace-install.ts`: this
 * module is the package's `./types` face, which the client loads, and importing a
 * host module that touches `node:fs` would pull the whole install path into the
 * browser bundle. The shape is restated for that reason and held to it by the one
 * assignment that builds it.
 */
/**
 * Which of the two axes a Skill install should use.
 *
 * `custom` is absent on purpose: a custom root is a path the caller would have to
 * supply, and a remote that accepted one would let the page mount any directory it
 * could name. The matrix reports those rows as unresolved instead.
 */
export interface FreeCodeGoSkillPlacement {
  readonly agent: 'harness' | 'agents'
  readonly scope: 'project' | 'user'
}

/** One row of the resolved placement matrix. */
export interface FreeCodeGoSkillPlacementRow {
  readonly agent: 'harness' | 'agents' | 'custom'
  readonly scope: 'project' | 'user'
  /** False when this combination has no destination here; `reason` says why. */
  readonly ok: boolean
  readonly root?: string
  readonly provenance?: string
  readonly reason?: string
}

/** The matrix as the settings page reads it. */
export interface FreeCodeGoSkillPlacements {
  /** The repository the rows were resolved against. */
  readonly workspace: string
  /** Whether that repository is trusted, which the project rows depend on. */
  readonly projectTrusted: boolean
  /** Where an install lands when the caller names no placement. */
  readonly defaultRoot: string
  readonly rows: readonly FreeCodeGoSkillPlacementRow[]
  /**
   * The remembered choice, when the user made one.
   *
   * Reported beside the rows rather than folded into them, because the two are
   * different facts: a row says whether a destination *can* be used here, and this
   * says which one the user asked for last. A remembered choice whose row is
   * currently unusable is still reported — the page has to be able to show what the
   * user chose, and why it cannot be honoured, instead of silently installing
   * somewhere else.
   */
  readonly preferred?: FreeCodeGoSkillPlacement
}

export interface FreeCodeGoSkillInstallReport {
  readonly name: string
  /** The source as the lockfile records it — canonical, not as it was typed. */
  readonly source: string
  /** The commit the content came from, or a content id when the source has none. */
  readonly resolvedCommit: string
  /** False means the files are in place and the record is not: the Skill is unverifiable. */
  readonly locked: boolean
  readonly replacedCommit?: string
  /** True when that same source was already installed and this install re-ran it. */
  readonly idempotent: boolean
  /** The steps taken, in order — the install's own account of what it did. */
  readonly steps: readonly string[]
  readonly lockfileWarning?: string
  /** One entry per Skill in the root that no longer matches the record; empty when all match. */
  readonly verification: readonly { readonly name: string; readonly reason: string; readonly path?: string }[]
  /** Names claimed by more than one source in this root's own record. */
  readonly collisions: readonly { readonly name: string; readonly claims: readonly { readonly source: string; readonly root: string }[] }[]
  /**
   * Where this install landed, when the caller chose a destination.
   *
   * Present only for a placement install: the default is the Marketplace's own
   * community root, which the page already knows, and reporting it as if it were a
   * choice would make "default" and "chosen default" the same answer.
   */
  readonly placement?: { readonly root: string; readonly provenance: string }
}

/** Persisted controls for the optional, plugin-owned engineering enhancement pack. */
export interface FreeCodeGoEngineeringSettings {
  readonly engineeringEnabled: boolean
  readonly engineeringSkillsEnabled: boolean
  /** The default-on starter subset (evidence, navigation, planning, debugging,
   *  and the user-invoked prompt-technique reference) that lives in its own
   *  asset root. On unless explicitly disabled. */
  readonly engineeringStarterSkillsEnabled: boolean
  /** The vendored superpowers workflow pack (MIT), kept on its own switch
   *  because it is model-invoked and auto-triggering: a user who wants the
   *  engineering disciplines should not get the autonomous delivery pipeline
   *  by surprise. Off unless explicitly enabled. */
  readonly engineeringSuperpowersSkillsEnabled: boolean
  /** Injects a one-screen capability map of the mounted Skills at session
   *  start, so a default-off library is still discoverable. */
  readonly engineeringSkillMapEnabled: boolean
  readonly engineeringQualityEnabled: boolean
  readonly engineeringMemoryEnabled: boolean
  readonly engineeringCouncilEnabled: boolean
  /** Independent participation switches for each council engine. */
  readonly engineeringCouncilDeepseekEnabled: boolean
  readonly engineeringCouncilCodexEnabled: boolean
  readonly engineeringCouncilClaudeEnabled: boolean
  readonly engineeringMemoryContextTokenBudget: number
  /**
   * Let a model choose which memories a keyword search recalls, instead of the
   * deterministic lexical rerank. Off by default: the lexical path is free,
   * reproducible, and already ranks by term coverage. On, the selector may
   * promote a memory that shares no wording with the query.
   */
  readonly engineeringMemorySelectorEnabled: boolean
  /**
   * Let a model clear a pending approval automatically when it can read the
   * action and judges it routine. Off by default. Anything it refuses, cannot
   * read, or declines to judge still reaches the user prompt.
   */
  readonly engineeringActionReviewEnabled: boolean
  readonly engineeringCodeGraphEnabled: boolean
  readonly engineeringCodeGraphAutoUpdate: boolean
  /** Which code-graph engine owns the Agent tool family. `auto` prefers the
   *  self-contained CodeGraph engine and falls back to Graphify. Only the
   *  selected engine registers tools, so a user never pays for both rosters. */
  readonly engineeringGraphEngine: 'auto' | 'graphify' | 'codegraph'
  /** Maximum independent/cross-examination rounds for the engine council. */
  readonly engineeringCouncilMaxRounds: number
  /** Per-run wall-clock limit for all council participants. */
  readonly engineeringCouncilTimeoutMs: number
  /** Minimum successful participant count required for a non-blocked report. */
  readonly engineeringCouncilQuorum: number
  /** Whether plan completion may trigger a council without an explicit tool call. */
  readonly engineeringCouncilAutoRun: boolean
  /** Promote an approved council plan to a durable Harness goal. */
  readonly engineeringLoopCapturePlan: boolean
  /** Run declared verification when a goal leaves the active phase. */
  readonly engineeringLoopVerifyOnComplete: boolean
  /** Let the Harness goal-round driver continue a plan goal without a user turn. */
  readonly engineeringLoopAutoContinue: boolean
  /** Round cap applied to a captured plan goal; bounds unattended continuation. */
  readonly engineeringLoopMaxGoalRounds: number
  /** Maximum total participant tokens requested by one council. */
  readonly engineeringCouncilMaxTokens: number
  /** Maximum number of councils that may execute concurrently in this Host. */
  readonly engineeringCouncilMaxConcurrent: number
  /** Lifetime of a user approval before implementation must be reviewed again. */
  readonly engineeringCouncilDecisionTtlMs: number
}

/** Browser-safe health state for one engineering module. */
export interface FreeCodeGoEngineeringModuleStatus {
  /**
   * Every module the Host reports, and therefore every id a surface may gate on.
   * `checkpoints` belongs here because the settings panel disables the whole
   * snapshot surface until the Host says the store opened; omitting the id made
   * that gate permanently false, so the feature was unreachable while its
   * remotes worked.
   */
  readonly id: 'skills' | 'scanner' | 'doctor' | 'quality' | 'memory' | 'council' | 'codegraph' | 'canvas' | 'checkpoints'
  readonly state: 'disabled' | 'available' | 'unavailable' | 'error'
  readonly detail: string
}

/** One bundled Skill pack and whether its switch currently mounts it. */
export interface FreeCodeGoSkillPackStatus {
  readonly id: 'starter' | 'engineering' | 'superpowers'
  readonly label: string
  readonly enabled: boolean
  /** Skills the pack ships, counted whether or not the pack is mounted. */
  readonly count: number
}

/** Browser-safe aggregate state for the engineering enhancement pack. */
/**
 * How the session-start capability map met its character budget.
 *
 * `entry-capped` means the pack is larger than the entry cap can enumerate, so
 * raising the budget would not help; `chars-exhausted` means the descriptions
 * filled the budget first, so raising it would. `full` means nothing was cut.
 */
export type FreeCodeGoSkillMapBudgetStrategy = 'full' | 'entry-capped' | 'chars-exhausted'

/**
 * What the model-facing Skill capability map rendered, against what it cost.
 *
 * The map is injected once per session and the user never sees it, so a silent
 * truncation is invisible in both directions: the model stops being told about
 * Skills and nothing anywhere says so. These figures are the Host-visible half
 * of that injection, kept next to the Skill counts they qualify.
 */
export interface FreeCodeGoSkillMapBudget {
  /** Which bound decided the rendered shape. */
  readonly strategy: FreeCodeGoSkillMapBudgetStrategy
  /** Skills found on disk, before the entry cap and the character budget. */
  readonly discovered: number
  /** Skills the model was actually told about. */
  readonly rendered: number
  /** Skills the character budget dropped after the entry cap. */
  readonly omitted: number
  /** Skills the entry cap removed before the budget was measured. */
  readonly entryCapped: number
  /** Descriptions shortened to fit the per-description cap. */
  readonly descriptionsTruncated: number
  /** Characters of the rendered block, header and footer included. */
  readonly renderedChars: number
  /** Characters the block would have needed with no entry or character bound. */
  readonly uncappedChars: number
  /** The character budget the block was measured against. */
  readonly budgetChars: number
}

/**
 * State of the engineering surfaces this plugin exposes.
 */
export interface FreeCodeGoEngineeringStatus extends FreeCodeGoEngineeringSettings {
  readonly modules: readonly FreeCodeGoEngineeringModuleStatus[]
  readonly builtinSkillCount: number
  /** Budget telemetry for the most recently injected Skill map, once one has
   *  been injected in this Host. Absent while Skills, the map, or the session
   *  start that would inject it are not in play. */
  readonly skillMapBudget?: FreeCodeGoSkillMapBudget
  /** Every bundled Skill pack, so a surface can name what a switch would add
   *  instead of only reporting the total. */
  readonly skillPacks: readonly FreeCodeGoSkillPackStatus[]
  readonly managedSkillRoot?: string
  readonly lastDoctorAt?: number
  readonly lastDoctorOk?: boolean
  readonly councilEngines?: Readonly<Record<FreeCodeGoEngineeringCouncilEngine, { readonly enabled: boolean; readonly available: boolean; readonly reason?: string }>>
}

/** One static capability-scan finding. Sensitive values are never returned. */
export interface FreeCodeGoEngineeringFinding {
  readonly rule: string
  readonly severity: 'info' | 'warning' | 'high' | 'critical'
  readonly message: string
  readonly location?: string
}

/** Bounded diagnostic report for the bundled engineering assets. */
export interface FreeCodeGoEngineeringDoctorReport {
  readonly ok: boolean
  readonly checkedAt: number
  readonly skills: readonly { readonly id: string; readonly valid: boolean; readonly digest: string; readonly findings: readonly FreeCodeGoEngineeringFinding[] }[]
  readonly findings: readonly FreeCodeGoEngineeringFinding[]
  /**
   * How far the sandbox deny list actually reaches.
   *
   * A separate section because the deny list is the one restriction a user is
   * most likely to overestimate: it is enforced over tool calls and in-process
   * file intents, and it is **not** a kernel-level deny, so an engine's own shell
   * redirection is the sandbox mode's business. `enforcedBy` uses the sandbox
   * profile's own vocabulary, because one fact with two synonyms is how a reader
   * ends up comparing two things that are the same.
   *
   * Absent when no deny patterns are configured, which is the ordinary state: an
   * empty list restricts nothing, and a section describing nothing is noise.
   */
  readonly denyEnforcement?: {
    readonly patterns: number
    readonly enforcedBy: 'tool-scope' | 'none'
    readonly kernelDenyAvailable: boolean
    /** Present whenever `enforcedBy` is not the whole story. */
    readonly fallbackReason?: string
  }
}

/** Trust level of a locally stored engineering memory record. */
export type FreeCodeGoEngineeringMemoryTrust = 'captured' | 'draft' | 'reviewed' | 'rejected' | 'superseded'

/** A bounded engineering-memory category intended for project history, not chat transcripts. */
/**
 * The kinds a durable engineering memory may carry, in the order the tool offers
 * them.
 *
 * One list, three readers: this union, the `engineering_memory_save` schema's
 * `enum`, and the store's `isMemoryKind`, which decides whether a kind arriving
 * through the outbox keeps its name or is coerced to `'note'`. Each of them was a
 * hand-written spelling of the same eight names, and an eight-member vocabulary is
 * the one most likely to drift one member at a time — a kind the schema never
 * offers is one no model can save, and a kind the store does not recognise loses
 * its name on the way back, with nothing on the wire to notice either.
 *
 * The recall weighting in the memory store is deliberately narrower
 * (`RECALL_DURABLE_KINDS`): that is a ranking decision, not the vocabulary.
 */
export const ENGINEERING_MEMORY_KINDS = ['decision', 'discovery', 'bugfix', 'change', 'blocker', 'verification', 'handoff', 'note'] as const

/**
 * Kind of fact one engineering memory entry records.
 */
export type FreeCodeGoEngineeringMemoryKind = typeof ENGINEERING_MEMORY_KINDS[number]

/** Compact memory metadata safe for search, list, and timeline responses. */
export interface FreeCodeGoEngineeringMemoryIndex {
  readonly id: string
  readonly title: string
  readonly kind: FreeCodeGoEngineeringMemoryKind
  readonly trust: FreeCodeGoEngineeringMemoryTrust
  readonly projectId: string
  readonly createdAt: number
  readonly detailTokens: number
}

/** Allowlisted provenance for one locally captured engineering observation. */
export interface FreeCodeGoEngineeringMemorySource {
  readonly sessionId: string
  readonly eventSequence: number
  readonly eventType: string
  readonly turn?: number
  readonly engine?: string
  readonly provider?: string
  readonly model?: string
  readonly filesRead: readonly string[]
  readonly filesWritten: readonly string[]
  readonly capturedAt: number
}

/** Full record returned only after an explicit UI review or Agent Get request. */
export interface FreeCodeGoEngineeringMemoryDetail extends FreeCodeGoEngineeringMemoryIndex {
  readonly body: string
  readonly tags: readonly string[]
  readonly sourceEngine?: string
  readonly sources: readonly FreeCodeGoEngineeringMemorySource[]
  /**
   * Other records this one is connected to, strongest connection first.
   *
   * Computed when the detail is read rather than stored. A stamped edge becomes
   * wrong the moment either side is deleted and invisible when a new record
   * arrives that should have been linked, so it would need invalidation on every
   * write plus a backfill migration — all to reconstruct a relation the source
   * rows already imply.
   */
  readonly related: readonly FreeCodeGoEngineeringMemoryRelation[]
}

/** Why two memory records are considered related. */
export type FreeCodeGoEngineeringMemoryRelationKind = 'shared-file' | 'same-session' | 'same-turn'

/**
 * One graph edge from the record being read to a neighbouring record.
 *
 * `weight` is the number of independent observations supporting the edge, so a
 * reader can separate a strong structural link from a single coincidence.
 */
export interface FreeCodeGoEngineeringMemoryRelation {
  readonly id: string
  readonly title: string
  readonly kind: FreeCodeGoEngineeringMemoryKind
  readonly trust: FreeCodeGoEngineeringMemoryTrust
  readonly relation: FreeCodeGoEngineeringMemoryRelationKind
  /** Evidence shared by both records: a repo-relative path, or a session id. */
  readonly via: string
  readonly weight: number
}

/** Bounded reviewed-memory index selected for an Agent session start. */
export interface FreeCodeGoEngineeringMemoryRecall {
  readonly projectId: string
  readonly tokenBudget: number
  readonly usedTokens: number
  readonly records: readonly FreeCodeGoEngineeringMemoryIndex[]
}

/** Browser-safe result of a plugin-private SQLite memory backup. */
export interface FreeCodeGoEngineeringMemoryBackup {
  readonly id: string
  readonly createdAt: number
  readonly bytes: number
}

/** How a consolidated fact was reconciled with existing memory (mem0-style ADD/UPDATE/DELETE/NOOP). */
export type FreeCodeGoEngineeringMemoryConsolidationAction = 'added' | 'updated' | 'superseded' | 'noop'

/** Per-fact outcome of one memory consolidation run. */
export interface FreeCodeGoEngineeringMemoryConsolidationItem {
  readonly fact: string
  readonly action: FreeCodeGoEngineeringMemoryConsolidationAction
  /** The memory record created or modified by this fact. */
  readonly memoryId?: string
  /** Records superseded by this fact (their knowledge was folded forward). */
  readonly supersededIds: readonly string[]
  readonly reason: string
}

/** Aggregate result of distilling one turn's observation into atomic facts. */
export interface FreeCodeGoEngineeringMemoryConsolidation {
  readonly projectId: string
  readonly items: readonly FreeCodeGoEngineeringMemoryConsolidationItem[]
}

/** Result of a bounded memory retention sweep. Reviewed and draft entries are retained. */
export interface FreeCodeGoEngineeringMemoryRetentionResult {
  readonly retentionDays: number
  readonly deletedMemories: number
  readonly deletedOutboxEntries: number
}

/** Cursor-bounded memory list for one current workspace. */
export interface FreeCodeGoEngineeringMemoryPage {
  readonly records: readonly FreeCodeGoEngineeringMemoryIndex[]
  readonly nextCursor?: string
}

/** A bounded temporal neighborhood around one memory record. */
export interface FreeCodeGoEngineeringMemoryTimeline {
  readonly anchor: FreeCodeGoEngineeringMemoryIndex
  readonly before: readonly FreeCodeGoEngineeringMemoryIndex[]
  readonly after: readonly FreeCodeGoEngineeringMemoryIndex[]
}

/** User-only decision that changes the trust state of an unreviewed draft. */
export type FreeCodeGoEngineeringMemoryReviewDecision = 'reviewed' | 'rejected' | 'superseded'

/** Browser-safe state for the optional official Graphify runtime. */
export interface FreeCodeGoEngineeringGraphRuntimeStatus {
  readonly state: 'unavailable' | 'ready' | 'installing' | 'error'
  readonly installed: boolean
  readonly version: string
  readonly runtimeDirectory: string
  readonly pythonPath?: string
  readonly wheelDigest?: string
  readonly reason?: string
}

/** One supported Graphify installation source exposed by the engineering page. */
export interface FreeCodeGoEngineeringGraphRuntimePackage {
  readonly id: 'managed-uv-python' | 'existing-python'
  readonly label: string
  readonly detail: string
  readonly compatible: boolean
  readonly requiresPath: boolean
  /** Best-effort PATH discovery; the executable is still version-checked in a private env. */
  readonly detectedPath?: string
}

/** Per-workspace state of the plugin-owned Graphify output directory. */
export interface FreeCodeGoEngineeringGraphProjectStatus {
  readonly state: 'unavailable' | 'missing' | 'ready' | 'building' | 'error'
  readonly projectId: string
  readonly graphPath: string
  readonly builtAt?: number
  readonly graphBytes?: number
  readonly reason?: string
}

/** Browser-safe state for the optional self-contained CodeGraph runtime. */
export interface FreeCodeGoEngineeringCodeGraphRuntimeStatus {
  readonly state: 'unavailable' | 'ready' | 'installing' | 'error'
  readonly installed: boolean
  readonly version: string
  readonly runtimeDirectory: string
  /** The launcher the plugin spawns: the bundled `node`/`node.exe` on Windows, `bin/codegraph` elsewhere. */
  readonly binaryPath?: string
  readonly bundleDigest?: string
  readonly reason?: string
}

/** One supported CodeGraph installation source exposed by the engineering page. */
export interface FreeCodeGoEngineeringCodeGraphRuntimePackage {
  readonly id: 'managed-bundle'
  readonly label: string
  readonly detail: string
  readonly compatible: boolean
  readonly requiresPath: boolean
}

/** Per-workspace state of the CodeGraph index. Unlike Graphify the index lives
 *  in the workspace (`<workspace>/.codegraph-freecodego`), which is why this
 *  status reports the index path the user can inspect or remove. */
export interface FreeCodeGoEngineeringCodeGraphProjectStatus {
  readonly state: 'unavailable' | 'missing' | 'ready' | 'building' | 'error'
  readonly projectId: string
  readonly indexPath: string
  readonly builtAt?: number
  readonly indexBytes?: number
  readonly reason?: string
}

/**
 * Stage a verification run has reached.
 */
export type FreeCodeGoEngineeringVerificationStage = 'scope' | 'build' | 'types' | 'lint' | 'tests'

/** Why a verification run is not confirmed, computed rather than inferred. */
export type FreeCodeGoEngineeringVerificationVerdict = 'verified' | 'unverified' | 'failed'

/** One independent check the verifier declared before running it. */
export interface FreeCodeGoEngineeringVerificationProbe {
  readonly id: string
  /** Program and arguments, spawned without a shell. */
  readonly command: readonly string[]
  /** Whether the command is expected to be refused by the code under test. */
  readonly expectation: 'pass' | 'fail'
  /** What breakage this probe would catch. Required, so the check is reviewable. */
  readonly rationale: string
}

/** What a declared probe actually did, including whether it held. */
export interface FreeCodeGoEngineeringVerificationProbeResult extends FreeCodeGoEngineeringVerificationProbe {
  readonly state: 'pass' | 'fail' | 'skipped' | 'unavailable' | 'cancelled' | 'refused'
  readonly exitCode?: number
  readonly durationMs: number
  readonly summary: string
  readonly held: boolean
}

/**
 * Outcome one verification run reported.
 */
export interface FreeCodeGoEngineeringVerificationResult {
  readonly id: string
  readonly checkedAt: number
  readonly stages: readonly {
    readonly id: FreeCodeGoEngineeringVerificationStage
    readonly state: 'pass' | 'fail' | 'skipped' | 'unavailable' | 'cancelled' | 'refused'
    readonly command?: readonly string[]
    /** Exit status of `command`, absent exactly when nothing ran. */
    readonly exitCode?: number
    readonly durationMs: number
    readonly summary: string
  }[]
  readonly probes?: readonly FreeCodeGoEngineeringVerificationProbeResult[]
  /** Absent on results persisted before the verdict existed. */
  readonly verdict?: FreeCodeGoEngineeringVerificationVerdict
  readonly unmet?: readonly string[]
}

/** Durable local state for a user- or Agent-triggered engineering task. */
export interface FreeCodeGoEngineeringJob {
  readonly id: string
  readonly projectId: string
  readonly kind: 'verification' | 'graph-build' | 'graph-update' | 'council'
  readonly state: 'queued' | 'running' | 'completed' | 'cancelled' | 'interrupted' | 'failed'
  readonly createdAt: number
  readonly startedAt?: number
  readonly finishedAt?: number
  readonly summary?: string
  readonly verification?: FreeCodeGoEngineeringVerificationResult
  readonly council?: FreeCodeGoEngineeringCouncilReport
}

/** Engines that may participate in a FreeCodeGo engineering council. */
export type FreeCodeGoEngineeringCouncilEngine = 'deepseek' | 'codex' | 'claude'

/** Explicit lifecycle for a reviewed plan from discussion through verification. */
export type FreeCodeGoEngineeringCouncilState =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'implementing'
  | 'awaiting_verification'
  | 'verifying'
  | 'completed'
  | 'partial'
  | 'blocked'
  | 'cancelled'
  | 'failed'
  | 'stale'
  | 'rejected'

/** One model-selected council request. Plans are data and are never treated as policy. */
export interface FreeCodeGoEngineeringCouncilRequest {
  readonly objective: string
  readonly plan: string
  readonly constraints?: readonly string[]
  readonly engines?: readonly FreeCodeGoEngineeringCouncilEngine[]
  readonly maxRounds?: number
}

/** One bounded participant outcome from an engine council round. */
export interface FreeCodeGoEngineeringCouncilParticipant {
  readonly engine: FreeCodeGoEngineeringCouncilEngine
  readonly provider: string
  readonly model: string
  readonly state: 'completed' | 'unavailable' | 'failed' | 'cancelled'
  readonly output?: string
  readonly error?: string
  readonly durationMs: number
}

/** A machine-readable, evidence-carrying finding emitted by one reviewer. */
export interface FreeCodeGoEngineeringCouncilFinding {
  readonly id: string
  readonly engine: FreeCodeGoEngineeringCouncilEngine
  readonly severity: 'info' | 'warning' | 'blocker'
  readonly title: string
  readonly evidence: string
}

/** Durable council report stored on the parent Session without hidden reasoning. */
export interface FreeCodeGoEngineeringCouncilReport {
  readonly id: string
  readonly sessionId: string
  readonly projectId: string
  readonly state: 'completed' | 'partial' | 'blocked' | 'cancelled' | 'failed'
  readonly createdAt: number
  readonly completedAt?: number
  readonly objective: string
  readonly plan: string
  readonly rounds: number
  readonly quorum: number
  /** Present only when fewer enabled engines than the configured quorum forced a lowered effective quorum. */
  readonly configuredQuorum?: number
  readonly participants: readonly FreeCodeGoEngineeringCouncilParticipant[]
  readonly consensus: string
  readonly dissent: string
  readonly finalRecommendation: string
  /** Versioned report schema for approval and recovery checks. */
  readonly reportVersion?: number
  /** Digest of objective, plan, constraints, and selected engines. */
  readonly planDigest?: string
  /** Revision of the workspace observed when the review completed, when available. */
  readonly workspaceRevision?: string
  /** Digest of the read-only and approval policy applied to this review. */
  readonly policyDigest?: string
  /** Structured, evidence-backed findings used by the approval risk gate. */
  readonly findings?: readonly FreeCodeGoEngineeringCouncilFinding[]
  /**
   * Approval risk verdict, derived from the same predicate as `state`: 'clear'
   * only for a review that actually cleared (`completed` or `partial`), and
   * 'blocked' whenever the review carries blocking findings, missed quorum, or
   * never finished. The approval gate refuses anything that is not 'clear',
   * including a report whose verdict is absent — a gate nobody recorded is not a
   * passed one — so a durable report restored from an older writer cannot be
   * approved on the strength of its state alone.
   */
  readonly riskGate?: 'clear' | 'blocked'
  readonly blockingFindings?: readonly string[]
  readonly decision?: FreeCodeGoEngineeringCouncilDecision
  readonly verification?: FreeCodeGoEngineeringVerificationResult
  readonly implementation?: FreeCodeGoEngineeringCouncilImplementation
}

/** Durable user decision associated with one finished engineering council. */
export interface FreeCodeGoEngineeringCouncilDecision {
  readonly id: string
  readonly state: 'approved' | 'rejected'
  readonly decidedAt: number
  readonly planDigest?: string
  readonly workspaceRevision?: string
  readonly policyDigest?: string
  readonly expiresAt?: number
}

/** Durable verification result associated with an approved engineering council. */
export interface FreeCodeGoEngineeringCouncilVerification {
  readonly id: string
  readonly result: FreeCodeGoEngineeringVerificationResult
}

/** Durable evidence that the primary Agent completed the approved implementation. */
export interface FreeCodeGoEngineeringCouncilImplementation {
  readonly id: string
  readonly completedAt: number
  readonly summary: string
  readonly workspaceRevision?: string
}

/** Durable task snapshot used to reconstruct interrupted council work after a Host restart. */
export interface FreeCodeGoEngineeringCouncilTask {
  readonly job: FreeCodeGoEngineeringCouncilJob
  readonly request: FreeCodeGoEngineeringCouncilRequest
  readonly policyDigest: string
}

/** Browser/model-safe live council task projection. */
export interface FreeCodeGoEngineeringCouncilJob {
  readonly id: string
  readonly sessionId: string
  readonly projectId: string
  readonly state: FreeCodeGoEngineeringCouncilState
  readonly createdAt: number
  readonly startedAt?: number
  readonly finishedAt?: number
  readonly report?: FreeCodeGoEngineeringCouncilReport
  readonly decision?: FreeCodeGoEngineeringCouncilDecision
  readonly verification?: FreeCodeGoEngineeringVerificationResult
  readonly implementation?: FreeCodeGoEngineeringCouncilImplementation
  readonly error?: string
  readonly updatedAt?: number
}

/** One workspace checkpoint manifest (content-addressed shadow snapshot). */
export interface FreeCodeGoEngineeringCheckpoint {
  readonly id: string
  readonly label: string
  readonly createdAt: number
  readonly entries: readonly { readonly file: string; readonly hash: string; readonly bytes: number }[]
  /** Pinned checkpoints survive the retention cap. */
  readonly pinned?: boolean
}

/**
 * One recorded region of a file, attributed to the tool call that changed it.
 *
 * `offset`/`removed`/`added` are how a caller describes the change without
 * shipping the file: the region the call wrote starts at `offset` (0-based, in the
 * file's current lines) and holds `added`, replacing `removed`. `supersededBy`
 * names a later hunk that covered these lines, and such a hunk cannot be reverted
 * on its own.
 */
export interface FreeCodeGoEngineeringHunk {
  readonly id: string
  readonly file: string
  readonly callId: string
  readonly at: number
  readonly offset: number
  readonly removed: readonly string[]
  readonly added: readonly string[]
  readonly supersededBy?: string
}

/** What reverting one hunk (or one call's hunks in one file) did. */
export type FreeCodeGoEngineeringHunkRevert =
  | { readonly ok: true; readonly file: string; readonly hunks: number; readonly relocated: boolean }
  | { readonly ok: false; readonly reason: 'unknown-hunk' | 'superseded' | 'drifted'; readonly detail: string }

/** What restoring one checkpoint would change, computed without touching files. */
export interface FreeCodeGoEngineeringCheckpointDiff {
  readonly modified: readonly string[]
  readonly addedSince: readonly string[]
  readonly deletedSince: readonly string[]
  readonly missingBlobs: number
  /** True when the checkpoint's capture list is a prefix, so `addedSince` is withheld. */
  readonly captureListTruncated: boolean
}

/** Result of restoring a workspace to a checkpoint. */
export interface FreeCodeGoEngineeringCheckpointRestoreResult {
  readonly restoredFiles: number
  readonly deletedFiles: number
  readonly missingBlobs: number
  /** True when the capture list is a prefix, so the deletion half was withheld. */
  readonly captureListTruncated: boolean
}

/** A bounded adapter payload that compatible Canvas plugins can render without raw Graphify JSON. */
export interface FreeCodeGoEngineeringCanvasGraph {
  readonly projectId: string
  readonly generatedAt: number
  readonly nodes: readonly { readonly id: string; readonly label: string; readonly kind?: string }[]
  readonly edges: readonly { readonly from: string; readonly to: string; readonly kind?: string }[]
  readonly truncated: boolean
}

/** One installable MCP or Skill recommendation shown in FreeCodeGo Community. */
export interface FreeCodeGoCapabilityMarketplaceItem {
  readonly id: string
  readonly kind: 'mcp' | 'skill'
  readonly title: string
  readonly description: string
  readonly category: string
  readonly sourceUrl: string
  readonly iconUrl?: string
  readonly author?: string
  readonly popularity: number
  readonly installed: boolean
  readonly installable: boolean
  readonly requiresConfiguration?: boolean
}

/** Query controls for the public MCP.so and skills.sh directory projection. */
export interface FreeCodeGoCapabilityMarketplaceRequest {
  readonly kind: 'mcp' | 'skill'
  readonly query?: string
  readonly category?: string
  readonly offset?: number
  readonly limit?: number
}

/** One bounded page from the public MCP or Skill community directory. */
export interface FreeCodeGoCapabilityMarketplacePage {
  readonly kind: 'mcp' | 'skill'
  readonly total: number
  readonly offset: number
  readonly limit: number
  readonly query?: string
  readonly categories: readonly { readonly id: string; readonly label: string; readonly count?: number }[]
  readonly items: readonly FreeCodeGoCapabilityMarketplaceItem[]
}

/** One exclusive resource statically claimed by a Loader entry. */
export type FreeCodeGoPluginConflictResource =
  | 'tool'
  | 'command'
  | 'settings'
  | 'route'
  | 'provider'
  | 'slot'

/** A plugin entry disabled before activation because it duplicated an active resource. */
export interface FreeCodeGoPluginConflictRecord {
  readonly id: string
  readonly detectedAt: number
  readonly resource: FreeCodeGoPluginConflictResource
  readonly resourceName: string
  readonly disabledEntryId: string
  readonly disabledModuleName: string
  readonly keptEntryId: string
  readonly keptModuleName: string
  /**
   * True when the stopped entry is one of this plugin's own stand-in mounts and
   * the entry that kept the resource is an official Harness module.
   *
   * The stand-in exists only for compositions that never selected the official
   * capability, so the Harness's own plugin outranking it is the intended
   * outcome rather than a conflict repair: the fallback is what yields. The
   * panel reads this to say so instead of reporting the Harness as the loser.
   */
  readonly yieldedToOfficial?: boolean
}

/** Durable policy and recent automatic repairs for third-party plugin conflicts. */
export interface FreeCodeGoPluginConflictSettings {
  readonly pluginConflictProtectionEnabled: boolean
  readonly pluginConflictRecords: readonly FreeCodeGoPluginConflictRecord[]
}

/** Browser-safe conflict-protection state. */
export interface FreeCodeGoPluginConflictStatus extends FreeCodeGoPluginConflictSettings {
  /**
   * Ids of the stored records the running tree still matches: the entry a record
   * names as disabled is stopped and the entry it names as kept is running.
   *
   * A record that no longer matches is history — a later composition superseded
   * the repair it describes — and a panel or notice that presents it as a live
   * repair tells the user their Harness disabled something it is now running.
   */
  readonly pluginConflictActiveRecords: readonly string[]
}

/** Persisted policy for checking the published FreeCodeGo package. */
export interface FreeCodeGoPluginUpdateSettings {
  readonly pluginUpdateChecksEnabled: boolean
}

/** Browser-safe state of one FreeCodeGo package update check or installation. */
export interface FreeCodeGoPluginUpdateStatus {
  readonly enabled: boolean
  readonly packageName: string
  readonly currentVersion: string
  /** Local profiles rebuild in place; published releases install through `dsh plugin`. */
  readonly installation: 'local' | 'release'
  /**
   * `owner/repo` whose releases this install follows. There is exactly one.
   *
   * A published bundle carries a `freecodego.harnessBaseline` that has to equal
   * the running Harness, so a second source could only offer a bundle built
   * against a different Harness — which is the failure the gate exists to
   * prevent. Reported so the settings page can name the source it is actually
   * using rather than imply a choice.
   */
  readonly releaseRepository: string
  /** Detected official Harness package version in the active profile. */
  readonly harnessVersion?: string
  /** Harness baseline declared by the installed FreeCodeGo bundle. */
  readonly harnessBaseline?: string
  readonly latestVersion?: string
  /** Web page of the release the check selected, for a user who wants its notes. */
  readonly releaseUrl?: string
  readonly phase: 'idle' | 'checking' | 'available' | 'up-to-date' | 'installing' | 'incompatible' | 'error'
  readonly checkedAt?: number
  readonly error?: string
  readonly restartRequired: boolean
  readonly rollbackPending?: boolean
  readonly rollbackReason?: string
}

/**
 * Stop-time review settings persisted with the FreeCodeGo profile.
 *
 * Declared as its own interface rather than folded into the Advisor's because the
 * two answer different questions: the Advisor reviews an *answer* after it was
 * written, while this reviews a *change* before the turn is allowed to end. The
 * one thing they share is the model route, which is why there is no review route
 * here — a second pair of provider/model fields would be a second place for the
 * same intent to be set and disagree.
 */
export interface FreeCodeGoReviewSettings {
  /**
   * `off` (the default) runs nothing at stop time, `record` writes findings to
   * the session, `gate` also injects them. The review tools work in every mode.
   */
  readonly reviewMode: 'off' | 'record' | 'gate'
  /** The least severe finding the gate delivers rather than only records. */
  readonly reviewThreshold: 'critical' | 'high' | 'medium' | 'low'
  /** Stops to wait after a delivery before delivering again. */
  readonly reviewCooldownTurns: number
  /**
   * Review each file with its own read-only child agent instead of one call.
   *
   * Off by default because it opens one child per reviewed file. When on, the
   * review the *tools* run uses it; the stop-time gate does not, since it would
   * multiply the cost of a pass that runs by itself.
   */
  readonly reviewDeep: boolean
  /**
   * Re-check `critical` and `high` findings with an independent adversarial pass.
   *
   * Off by default: it costs a call per escalated finding, and its shipped
   * implementation is one route rather than a multi-engine council — see
   * `review/escalation-model.ts` for exactly what that does and does not catch.
   */
  readonly reviewEscalation: boolean
}

/**
 * The review report and its parts, re-exported for the browser contract.
 *
 * Re-exported rather than restated: the report is deliberately plain data — the
 * module that assembles it says so for exactly this reason — and a second copy of
 * the shape here would be a second answer to "what does a finding contain" that
 * the UI and the engine could disagree about.
 */
import type { ReviewReport } from './review/report.ts'
import type { ReviewRunSnapshot } from './review/runs.ts'

export type { ReviewReport, ReviewRunState, ReviewTargetSummary, ReviewMode } from './review/report.ts'
export type { ReviewComment, ReviewCategory, ReviewSeverity, ReviewCommentState } from './review/comments.ts'
export type { ReviewCoverage, ReviewFileOutcome } from './review/coverage.ts'
export type { ReviewBudgetSummary } from './review/budget.ts'
export type { EscalationReport } from './review/escalation.ts'
export type { ReviewRunSnapshot } from './review/runs.ts'

/**
 * One workspace's review surface, as the settings page reads it.
 *
 * Carries the settings as well as the runs because a panel that could start a
 * review but not show what mode it would run in would have to read the settings
 * twice through two paths, and the two could disagree.
 */
export interface FreeCodeGoReviewStatus {
  /** The workspace every run in this snapshot is about. */
  readonly workspace: string
  /** Whether a review started from here would use the per-file child agent. */
  readonly deep: boolean
  readonly mode: 'off' | 'record' | 'gate'
  readonly threshold: 'critical' | 'high' | 'medium' | 'low'
  readonly cooldownTurns: number
  readonly escalation: boolean
  /** Runs this plugin still remembers, most recent first. */
  readonly runs: readonly ReviewRunSnapshot[]
  /** The most recent run's full report, when one is still retained. */
  readonly report?: ReviewReport
}

/** A review settings change from the settings page. */
export interface FreeCodeGoReviewUpdate {
  readonly reviewMode?: 'off' | 'record' | 'gate'
  readonly reviewThreshold?: 'critical' | 'high' | 'medium' | 'low'
  readonly reviewCooldownTurns?: number
  readonly reviewDeep?: boolean
  readonly reviewEscalation?: boolean
}

/** What the settings page asks a review to cover. */
export interface FreeCodeGoReviewStartRequest {
  readonly mode?: 'workspace' | 'range' | 'commit'
  readonly from?: string
  readonly to?: string
  readonly commit?: string
  readonly background?: string
  readonly exclude?: readonly string[]
}

/** Cross-engine Advisor settings persisted with the FreeCodeGo profile. */
export interface FreeCodeGoAdvisorSettings {
  /** Prefix avoids collisions with the bundle's default-engine settings. */
  readonly advisorEnabled: boolean
  readonly advisorMode: 'async' | 'catchup' | 'blocker-only'
  readonly advisorProvider: string
  readonly advisorModel: string
  readonly advisorAllowAgentControl: boolean
  readonly advisorInterruptCooldownTurns: number
  /** Feed durable Advisor findings into project memory as pending drafts. */
  readonly advisorMemoryDraftsEnabled: boolean
}

/** Browser-safe aggregate state for the Host-owned Advisor runtimes. */
export interface FreeCodeGoAdvisorStatus {
  readonly enabled: boolean
  readonly mode: 'async' | 'catchup' | 'blocker-only'
  readonly provider?: string
  readonly model?: string
  readonly routeReady: boolean
  readonly allowAgentControl: boolean
  readonly interruptCooldownTurns: number
  readonly reviewTools: readonly ('read' | 'glob' | 'grep')[]
  readonly activeSessions: number
  readonly queuedReviews: number
  readonly noteCount: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly lastError?: string
  /** Highest still-active failure backoff boundary across sessions, in turn number. */
  readonly backoffRemainingTurns?: number
  readonly watchdogFiles: readonly string[]
  /**
   * Side channels (Advisor and each council perspective) whose own prompt is at
   * or past the compaction threshold, worst first. Absent when nothing has been
   * measured yet — an unmeasured channel is not evidence of a problem.
   */
  readonly sideChannelWarnings?: readonly string[]
}

/** One text-capable Harness route eligible for a second-model Advisor review. */
export interface FreeCodeGoAdvisorModel {
  readonly id: string
  readonly displayName: string
  /** Registered Harness LLM provider, never a native worker identity. */
  readonly provider: string
  readonly description: string
}

/** A durable Advisor suggestion safe to present in the settings sidebar. */
export interface FreeCodeGoAdvisorNote {
  readonly id: string
  readonly sessionId: string
  readonly turn: number
  readonly severity: 'nit' | 'concern' | 'blocker'
  readonly note: string
  readonly delivery: 'record' | 'inject' | 'steer'
  readonly time: number
}

/** One independent perspective within an explicit Advisor Council review. */
export interface FreeCodeGoAdvisorCouncilFinding {
  readonly role: 'architecture' | 'security' | 'testing'
  readonly severity: 'nit' | 'concern' | 'blocker'
  readonly note: string
}

/** Durable Council output. Findings are preserved separately rather than force-merged. */
export interface FreeCodeGoAdvisorCouncilReport {
  readonly id: string
  readonly sessionId: string
  readonly turn: number
  readonly provider: string
  readonly model: string
  readonly createdAt: number
  readonly findings: readonly FreeCodeGoAdvisorCouncilFinding[]
}

/** User-editable partial update for the FreeCodeGo Advisor configuration. */
export interface FreeCodeGoAdvisorUpdate {
  readonly advisorEnabled?: boolean
  readonly advisorMode?: 'async' | 'catchup' | 'blocker-only'
  readonly advisorProvider?: string
  readonly advisorModel?: string
  readonly advisorAllowAgentControl?: boolean
  readonly advisorInterruptCooldownTurns?: number
}

/** One immutable item of the live todo/focus-chain list (todo/write shape). */
export interface FreeCodeGoFocusTodo {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

/** Probe result for one candidate language server (LSP auto-mount). */
export interface FreeCodeGoLspMountServer {
  readonly id: string
  readonly command: string
  readonly available: boolean
}

/** Liveness of the probe-based LSP stack (session diagnostics for all engines). */
export interface FreeCodeGoLspMountStatus {
  readonly enabled: boolean
  readonly mounted: boolean
  readonly servers: readonly FreeCodeGoLspMountServer[]
  readonly error?: string
}

/**
 * The session-automation switches, mirrored for the settings UI.
 *
 * Declared here rather than beside the runtime because this is a Remote
 * boundary: `automationSettingsUpdate` takes and returns these, and the Host
 * face generator requires every boundary type to be exported from a public
 * non-root subpath (`@deepseek-ai/.../types`). `automation.ts` owns the schema,
 * the defaults, and the projection, and imports this shape from here.
 */
export interface FreeCodeGoAutomationSettings {
  /** Master switch for declarative failure recovery. */
  readonly hookChainsEnabled: boolean
  /** Deepest recovery chain a rule may start before dispatch is refused. */
  readonly hookChainsMaxDepth: number
  /** Default wait before an identical chain event may fire again. */
  readonly hookChainsCooldownMs: number
  /** Master switch for the calendar planner. */
  readonly scheduledTasksEnabled: boolean
}

/** User-editable partial update for {@link FreeCodeGoAutomationSettings}. */
export interface FreeCodeGoAutomationSettingsUpdate {
  readonly hookChainsEnabled?: boolean
  readonly hookChainsMaxDepth?: number
  readonly hookChainsCooldownMs?: number
  readonly scheduledTasksEnabled?: boolean
}

/** All FreeCodeGo guard/quality toggles, mirrored for the settings UI. */
export interface FreeCodeGoGuardSettingsStatus {
  /** Credential-file read protection (tool-guards). */
  readonly envReadGuardEnabled: boolean
  /** Doom-loop detection for the native engines' own tools (tool-guards). */
  readonly doomLoopGuardEnabled: boolean
  /** Probe-based LSP stack (lsp-mount). */
  readonly lspEnabled: boolean
  /** Post-compaction rehydration (rehydration.ts). */
  readonly rehydrationEnabled: boolean
  /** Conversation-arc section in rehydrated context, opt-in (rehydration.ts). */
  readonly rehydrationArcEnabled: boolean
  /** Advisor findings persisted as memory drafts (advisor.ts). */
  readonly advisorMemoryDraftsEnabled: boolean
  /** Declarative command policy with load-time example validation (command-policy.ts). */
  readonly commandPolicyEnabled: boolean
  /** Plan Mode: structural refusal of workspace mutation (plan-mode.ts). */
  readonly planModeEnabled: boolean
  /** Model-visible context budget, injected at band granularity (context-budget.ts). */
  readonly contextBudgetEnabled: boolean
  /** Cache-cold clearing: shrink the prompt when the cache is provably expired (cache-cold.ts). */
  readonly cacheColdClearEnabled: boolean
  /** Pre-call request-shape fingerprinting for cache-break attribution (request-shape.ts). */
  readonly cacheBreakAttributionEnabled: boolean
  /** Streaming repetition guard for the model's own output (assistant-loop-guard.ts). */
  readonly assistantLoopGuardEnabled: boolean
  /** Model-visible prompt-composition breakdown and usage tree (prompt-composition.ts). */
  readonly promptCompositionEnabled: boolean
  /** Live LSP probe/mount result, present once probed. */
  readonly lsp?: FreeCodeGoLspMountStatus
}

/** User-editable partial update for {@link FreeCodeGoGuardSettingsStatus}. */
export interface FreeCodeGoGuardSettingsUpdate {
  readonly envReadGuardEnabled?: boolean
  readonly doomLoopGuardEnabled?: boolean
  readonly lspEnabled?: boolean
  readonly rehydrationEnabled?: boolean
  readonly rehydrationArcEnabled?: boolean
  readonly advisorMemoryDraftsEnabled?: boolean
  readonly commandPolicyEnabled?: boolean
  readonly planModeEnabled?: boolean
  readonly contextBudgetEnabled?: boolean
  readonly cacheColdClearEnabled?: boolean
  readonly cacheBreakAttributionEnabled?: boolean
  readonly assistantLoopGuardEnabled?: boolean
  readonly promptCompositionEnabled?: boolean
}

/** Public, credential-free community catalog payload served to the settings page. */
export type CommunityCatalogPayload = { readonly updated?: string; readonly plugins: readonly CommunityCatalogPlugin[] }

/** One tool whose JSONSchema is withheld until the model asks for it. */
export interface FreeCodeGoDeferredToolEntry {
  readonly name: string
  /** Serialized schema size, which is the number the deferral actually saves. */
  readonly chars: number
}

/**
 * Live deferred-tool-schema state (Remote boundary type).
 *
 * Exists so the settings switch is readable as well as writable: a knob the
 * panel can only write renders as permanently off regardless of the setting.
 */
export interface DeferredToolStatus {
  readonly enabled: boolean
  readonly deferred: readonly FreeCodeGoDeferredToolEntry[]
  readonly deferredChars: number
  /** Rough token cost avoided on every request, at the ~4-chars-per-token
   * convention the spend measurements use. */
  readonly deferredTokens: number
  /** Bytes of tool schema that stay in the request unconditionally. */
  readonly immediateChars: number
  /** Agents currently holding a deferral scope. */
  readonly activeAgents: number
}

/** Runtime kind of one Headroom context compression. */
export type HeadroomKind =
  | 'json' | 'diff' | 'search' | 'log' | 'prose'
  | 'html' | 'tabular' | 'config' | 'lossless' | 'dedup' | 'code'

/** Live Headroom context-compression state and savings counters (Remote boundary type). */
export interface HeadroomStats {
  readonly enabled: boolean
  /** Cross-turn verbatim dedup. Reported because the settings switch binds to
   * it: a knob the panel can write but not read renders as permanently off. */
  readonly dedupEnabled: boolean
  /** Lossless read folds. Same contract as {@link dedupEnabled}. */
  readonly foldReads: boolean
  /** Code skeletonization of read results. Same contract as {@link dedupEnabled}. */
  readonly codeSkeletonEnabled: boolean
  readonly compressions: number
  readonly originalBytes: number
  readonly compressedBytes: number
  readonly logCompressions: number
  readonly jsonCompressions: number
  readonly diffCompressions: number
  readonly searchCompressions: number
  readonly proseCompressions: number
  readonly htmlCompressions: number
  readonly tabularCompressions: number
  readonly configCompressions: number
  readonly losslessCompressions: number
  readonly dedupCompressions: number
  /**
   * Whether a lossless fold that clears the bar ships on its own. Read back like
   * the other policy switches, so a knob the panel can write cannot render as off.
   */
  readonly foldPolicy: 'reversible' | 'max'
  /**
   * Renders the rule **held** instead of shipping, and had to be beaten by the typed
   * stages: a whole-payload Stage 2 fold, a mixed-content section's own fold, the
   * splice that would have carried it, and the cross-turn pointer over a repeat. All
   * four are one event to a reader — a reversible or partial rendering was on offer
   * and the chain had to beat it on bytes — so they share these counters.
   * `deferred = superseded + settled` holds by construction (`adopt`,
   * `settleDeferred`, and `compressSection`), and a panel needs all three to tell a
   * payload whose render shipped from one whose render was beaten to half its size.
   * Counted together on purpose: the pointer is as much a render of this payload as
   * the fold is, and a ledger that only counted folds would report a repeat that was
   * re-compressed by a branch (`headroom-extra.spec.ts`) as nothing having happened.
   */
  readonly foldDeferred: number
  /** Held renders a typed stage beat on bytes. */
  readonly foldSuperseded: number
  /** Held renders that shipped because no typed stage beat them. */
  readonly foldSettled: number
  /** Read results replaced by a byte-exact-line skeleton of the same file. */
  readonly codeSkeletonCompressions: number
  readonly protectedCount: number
  readonly ccrEntries: number
  readonly ccrBytes: number
  readonly retrievals: number
  /** Retrieve calls that found the entry expired/evicted (tombstone returned). */
  readonly retrieveMisses: number
  /**
   * Writes the store refused at the whole-payload branches that check the write
   * themselves (`json`, `html`). Diagnostics rather than a knob: a store at its
   * ceiling is where compression starts to degrade, because those branches fall
   * through to the generic stages instead of ending the chain, and a rising count is
   * what explains a delivery in a shape the payload did not have.
   */
  readonly ccrWriteRefusals: number
  /**
   * Upstream project, license, reviewed ref, and this port's revision, composed into
   * one sentence (`headroomProvenance`). The panel renders it, which is the point:
   * the sentence names the upstream ref this build tracks, the one fact a reader needs
   * when the port and its upstream drift — and the panel used to state the project and
   * the license in hand-written prose that could not move when the port did.
   *
   * It stands in for three fields: this sentence plus two atomic parts
   * (`portVersion`, `upstreamRevision`) that nothing read — a second and third
   * spelling of one fact, on a surface whose only consumer is a human-facing panel.
   * The parts remain on `HEADROOM_PORT`, which composes this string, and a consumer
   * that has to *compare* a revision reads them there rather than from a status echo.
   */
  readonly provenance: string
}

/** One of the Harness file-sandbox modes, weakest first. */
export type FreeCodeGoSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

// ─── Spec artifacts ─────────────────────────────────────────────────────────

/**
 * One file of an exported spec bundle.
 *
 * `bytes` rather than the content: the caller asked for a durable artifact on
 * disk, and echoing the whole document back through the Remote boundary would
 * double the transfer for no reader.
 */
export interface FreeCodeGoEngineeringSpecArtifact {
  readonly file: string
  readonly bytes: number
}

/** Outcome of exporting one council report as workspace spec artifacts. */
export type FreeCodeGoEngineeringSpecBundle =
  | {
    readonly written: true
    readonly id: string
    /** Absolute directory written; always beneath `<workspace>/specs/<id>`. */
    readonly directory: string
    readonly files: readonly FreeCodeGoEngineeringSpecArtifact[]
    readonly tasks: number
  }
  | {
    readonly written: false
    /** Why nothing was written. Absence of a reason is never a success signal. */
    readonly reason: string
  }

/** One derived task in an exported spec bundle. */
export interface FreeCodeGoEngineeringSpecTask {
  readonly id: string
  readonly title: string
  readonly detail: string
  readonly severity: 'info' | 'warning' | 'blocker'
  readonly blockedBy: readonly string[]
}

// ─── Memory-derived Skill drafts ────────────────────────────────────────────

/** One draft Skill derived from a cluster of reviewed project memory. */
export interface FreeCodeGoEngineeringSkillDraft {
  /** Kebab-case Skill name, valid for the discovery contract. */
  readonly name: string
  /** The cluster key this draft was derived from (a tag or `kind:<kind>`). */
  readonly key: string
  /** Reviewed memory ids the draft cites; every claim traces to one of these. */
  readonly sources: readonly string[]
  /** The complete `SKILL.md` body, frontmatter included. */
  readonly content: string
}

/** A group of memories judged to describe one practice. */
export interface FreeCodeGoEngineeringSkillDraftCluster {
  readonly key: string
  readonly memories: readonly {
    readonly id: string
    readonly title: string
    readonly kind: FreeCodeGoEngineeringMemoryKind
    readonly createdAt: number
  }[]
}

/**
 * One finding from the publish pre-flight.
 *
 * Declared here rather than imported from `skills/publish.ts`, because this file is
 * loaded by the browser too: the shape crosses the remote boundary, so it is a
 * contract and not a host implementation detail. The host's own report is this shape
 * field for field, so nothing is mapped on the way out.
 */
export interface FreeCodeGoSkillPublishFinding {
  readonly severity: 'error' | 'warning'
  readonly code: 'name' | 'description' | 'size' | 'dangerous-command'
  readonly message: string
}

/**
 * What the publish pre-flight concluded about one `SKILL.md`.
 *
 * `ok` is false only for an error-severity finding: a draft with warnings is
 * publishable, and telling the user otherwise would train them past the report.
 */
export interface FreeCodeGoSkillPublishReport {
  readonly ok: boolean
  readonly name?: string
  readonly description?: string
  readonly tokens: number
  readonly limitTokens: number
  readonly findings: readonly FreeCodeGoSkillPublishFinding[]
}

/** Result of one draft-generation run. */
export interface FreeCodeGoEngineeringSkillDraftResult {
  /**
   * Drafts written to disk; empty when nothing clustered large enough.
   *
   * Each entry carries the publish pre-flight's verdict on its own file, because the
   * question the pre-flight answers — could this be published as it stands — is worth
   * asking the moment the draft exists rather than an hour later, when the draft is
   * what the user is looking at.
   */
  readonly drafts: readonly { readonly name: string; readonly sources: number; readonly preflight: FreeCodeGoSkillPublishReport }[]
  /** Absolute directory the drafts were written under, when any were. */
  readonly directory?: string
  /** Why nothing was produced, when nothing was. */
  readonly reason?: string
}

// ─── Deterministic capability evaluation ────────────────────────────────────

/** Feature area one evaluation case belongs to. */
export type FreeCodeGoEngineeringEvalSuite =
  | 'guards'
  | 'repo-map'
  | 'memory'
  | 'headroom'
  | 'council'
  | 'spec'
  | 'media'
  | 'rehydration'
  | 'wire'
  | 'conflicts'
  | 'usage'
  | 'quality'
  | 'version'
  | 'cache'
  | 'advisor'
  | 'progress'
  | 'agnes'
  | 'update'
  | 'assets'
  | 'skill'
  | 'compressor'
  | 'catalog'
  | 'buckets'
  | 'bridge'
  | 'runtime'
  | 'media-chain'
  | 'catalog-merge'
  | 'parsers'
  | 'validators'
  | 'community'
  | 'sizer'
  | 'crusher'
  | 'checkpoint'
  | 'events'
  | 'catalog-filter'
  | 'account'
  | 'job'
  | 'adapter'
  | 'routing'
  | 'preset'
  | 'lsp'
  | 'review'

/**
 * One deterministic capability check.
 *
 * `observed`/`required` carry the raw measurement, so a reader can judge the
 * margin rather than only the verdict: a case that barely passes and one that
 * passes by a wide margin are different signals about how close a regression is.
 */
export interface FreeCodeGoEngineeringEvalCase {
  readonly id: string
  readonly suite: FreeCodeGoEngineeringEvalSuite
  /** What the case proves, in one sentence. */
  readonly claim: string
  readonly passed: boolean
  readonly observed: number
  readonly required: number
  /** Human-readable measurement, e.g. `14/14 secret basenames refused`. */
  readonly detail: string
  /** Present only when a case failed, naming the unmet threshold or the error. */
  readonly failure?: string
}

/**
 * Result of one full evaluation run.
 *
 * `score` is the passed fraction and `ok` is the all-pass boolean. They are both
 * present because they answer different questions: `ok` gates a release, while
 * `score` tracks direction over time when a change trades one case for another.
 */
export interface FreeCodeGoEngineeringEvalReport {
  readonly version: 1
  readonly suites: readonly FreeCodeGoEngineeringEvalSuite[]
  readonly cases: readonly FreeCodeGoEngineeringEvalCase[]
  readonly passed: number
  readonly total: number
  readonly score: number
  readonly ok: boolean
  readonly checkedAt: number
}

/**
 * Browser-safe view of one session's file-sandbox policy.
 *
 * The Harness owns the policy; FreeCodeGo only projects it for the settings
 * surface. `override` is this session's own last logged choice and is absent
 * until the user picks one, while `mode` is the value actually in force after
 * the deployment default is applied.
 */
export interface FreeCodeGoSandboxStatus {
  readonly sessionId: string
  readonly mode: FreeCodeGoSandboxMode
  readonly override?: FreeCodeGoSandboxMode
  readonly defaultMode: FreeCodeGoSandboxMode
  /** True once the session is live; a restored or closed session reports its durable last value. */
  readonly live: boolean
  /** Absolute directory that `workspace-write` may modify in this session. */
  readonly workspaceRoot?: string
}

/**
 * Step machine of a federated sign-in (Google / GitHub) that ends in a
 * registration decision instead of an issued session.
 *
 * Declared here rather than beside the parser in `oauth-login.ts` because it
 * crosses a Remote boundary: the Typert generator refuses a boundary type that
 * is not exported from the package's public type subpath, and a refused type
 * fails generation for the whole package — every Remote in it, not just this
 * one. Keep boundary types in this file.
 */
export type OAuthLoginPendingStep = 'choose-account' | 'email-completion' | 'bind-login'

/** Browser-safe projection of one pending registration session. */
export interface OAuthLoginPendingRegistration {
  readonly step: OAuthLoginPendingStep
  /** Email the backend resolved from the provider profile (may be masked). */
  readonly email?: string
  readonly invitationRequired: boolean
  readonly emailVerified: boolean
  readonly displayName?: string
  readonly avatarUrl?: string
}

/** Durable lifecycle phase of a goal, as the engineering loop reports it. */
export type FreeCodeGoEngineeringLoopPhase = 'active' | 'paused' | 'blocked' | 'complete'

/**
 * The autonomous engineering loop for one session, as the settings surface
 * renders it.
 *
 * The loop has no scheduler of its own: it is the Harness goal machinery with
 * plugin-owned policy around it. `dsh-goal-round-driver` owns continuation,
 * `dsh-tool-goal` owns the model's own goal control, and this plugin decides
 * only when a goal exists (an approved plan), whether the driver may continue
 * without a user turn (`activation`), and what runs when the goal stops.
 *
 * Every field but `available` and `autoContinueEnabled` is absent until the
 * session holds a goal, so a panel can render the switch state before any goal
 * exists without inventing a placeholder goal.
 */
export interface FreeCodeGoEngineeringLoopStatus {
  /** False when the composition mounts no Harness goal service. */
  readonly available: boolean
  /** The auto-continue switch itself, reported with or without a goal. */
  readonly autoContinueEnabled: boolean
  readonly goalId?: string
  readonly phase?: FreeCodeGoEngineeringLoopPhase
  /**
   * Process-local continuation authority, which is *not* the durable phase: a
   * goal can be `active` and `disarmed` at once, and that pair is the honest
   * description of "the work still owes a finish, but nobody may start the next
   * round by themselves".
   */
  readonly activation?: 'armed' | 'disarmed'
  readonly roundsStarted?: number
  /** The cap this goal was created with; `resume` refuses once it is reached. */
  readonly maxGoalRounds?: number
  readonly createdAt?: number
  readonly updatedAt?: number
  /** Stable blocker code and message, present exactly while `phase` is `blocked`. */
  readonly blockedCode?: string
  readonly blockedMessage?: string
  /** Bounded first line of the objective — enough to recognise the goal. */
  readonly objectiveExcerpt?: string
}

/**
 * Why a project-scoped surface was admitted or refused.
 *
 * Stable codes rather than prose: the settings surface labels a reason, and
 * `engineering_doctor` groups by it, so a new refusal needs a new code. The two
 * admitting reasons are distinguished because they mean opposite things —
 * `granted` is a user decision, `global-disabled` is the gate being off — and a
 * reader that conflates them cannot tell an audited grant from an unguarded
 * deployment.
 */
export type FreeCodeGoTrustReason = 'granted' | 'global-disabled' | 'no-record' | 'revoked' | 'not-a-repository'

/** One repository root's admission decision. */
export interface FreeCodeGoTrustDecision {
  readonly trusted: boolean
  readonly reason: FreeCodeGoTrustReason
}

/** One stored grant. */
export interface FreeCodeGoTrustEntry {
  /** Canonical repository root the grant covers. */
  readonly root: string
  /** ISO timestamp of the most recent grant. */
  readonly grantedAt: string
}

/** The durable grant record, read and written as a whole. */
export interface FreeCodeGoTrustRecord {
  /** Schema version; a mismatch is read as an empty record. */
  readonly version: number
  readonly entries: readonly FreeCodeGoTrustEntry[]
}

/**
 * What the settings surface renders for the gate.
 *
 * `enabled` reports the resolved master switch (settings and environment
 * folded), while `recordPath` names the file so a user can audit it directly —
 * the record deliberately lives outside the workspace, so it has to be
 * discoverable from inside the settings surface or it is not auditable at all.
 */
export interface FreeCodeGoTrustStatus {
  readonly enabled: boolean
  readonly recordPath: string
  readonly entries: readonly FreeCodeGoTrustEntry[]
  /** Resolved decision for the repository the caller asked about, when one was supplied. */
  readonly current?: FreeCodeGoTrustDecision
  /** Canonical repository root the caller asked about, when one was supplied. */
  readonly currentRoot?: string
}

/**
 * One section of the unified inspect report (G9).
 *
 * `status` and `reason` are both required by the reader's job rather than by
 * tidiness: a section that could not be collected has to be distinguishable from
 * one that collected nothing, because "no MCP servers configured" and "the MCP
 * config was unreadable" look identical when a section is merely absent.
 */
export interface FreeCodeGoInspectSection {
  readonly id: string
  readonly title: string
  readonly status: 'ok' | 'unavailable'
  /** Present exactly when `status` is `unavailable`. */
  readonly reason?: string
  /** `null` when unavailable; otherwise the section's own shape. */
  readonly data: JsonValue
}

/**
 * Every loaded surface in one report.
 *
 * Served by `engineering_inspect` (with `json: true`), by the `/inspect`
 * command, and by the `inspectReport` Remote, all from one collection pass — see
 * `inspect/collect.ts` for why the three do not collect independently.
 */
export interface FreeCodeGoInspectReport {
  readonly generatedAt: number
  /** Section ids that could not be collected, so a reader can see the holes first. */
  readonly unavailable: readonly string[]
  readonly sections: readonly FreeCodeGoInspectSection[]
}

/**
 * The plan a user is being asked to approve.
 *
 * `empty` and `warnings` are both required rather than inferred from `body`:
 * a client that rendered nothing for an empty plan would leave Plan Mode active
 * with no visible action and no explanation, which is the state the review
 * surface exists to prevent. The section lists are separate from `warnings`
 * because a UI may want to mark the headings rather than print a sentence.
 */
export interface FreeCodeGoPlanReviewSurface {
  /** True when no plan has been written yet. The surface is still approvable. */
  readonly empty: boolean
  /** Numbered lines, ready to render. */
  readonly body: string
  readonly lineCount: number
  /** Where the plan lives, so a reviewer can open the file itself. */
  readonly path: string
  /** Sections with no heading, in canonical order. */
  readonly missingSections: readonly string[]
  /** Sections whose heading is followed by nothing. */
  readonly emptySections: readonly string[]
  readonly warnings: readonly string[]
}

/**
 * A rework request: line-level remarks, plus an overall note.
 *
 * The line numbers are the ones `planReviewOpen` printed, so a remark cannot
 * address a different line than the one the user selected.
 */
export interface FreeCodeGoPlanReviewRequest {
  readonly sessionId: string
  readonly comments?: readonly { readonly startLine: number; readonly endLine: number; readonly text: string }[]
  readonly notes?: string
}

/**
 * The curated-memory results that cross a Remote boundary.
 *
 * Re-exported here rather than only from the package root because the Typert
 * contract generator accepts a boundary type only when it is reachable through a
 * *concrete* subpath export of the owning package, and `./types` is the one this
 * package declares. A type reachable only from the root entry fails
 * `build:lib:host` at the contract step with "must be exported from a public
 * non-root type subpath" — which is how the memory Remotes shipped a contract
 * that could not be regenerated.
 *
 * Re-exports, not restatements: `memory-pipeline.ts`, `manifest.ts` and
 * `forget.ts` own these shapes, and a second declaration here is exactly the
 * drift this package's contract test exists to catch.
 */
export type { ProjectConfigReport } from './project-config.ts'
export type { MemoryConsolidation } from './memory/memory-pipeline.ts'
export type { MemoryManifest } from './memory/manifest.ts'
export type { ForgetRefusal } from './memory/forget.ts'
