/**
 * Payment, gateway pricing, and token-usage remotes for the FreeCodeGo Harness
 * plugin: balance-credit plans, the checkout order lifecycle, the
 * account-visible tariff catalog, and local/gateway usage snapshots. The
 * plugin class satisfies the narrow host view below; members that map to
 * plugin methods delegate back to the live instance so instance-level
 * overrides (tests, future remotes) keep working.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/payment-remotes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { FreeCodeGoAccountCoordinator, FreeCodeGoApiClient, FreeCodeGoModelOptionGroup, FreeCodeGoReceiptDocument } from '@deepseek-ai/dsh-freecodego-api'
import type { FreeCodeGoGatewayModelPrice, FreeCodeGoImagePriceTier, FreeCodeGoPaymentChannel, FreeCodeGoPaymentConfig, FreeCodeGoPaymentOrder, FreeCodeGoPaymentPlan, GatewayUsageSnapshot, JsonValue, LocalTokenUsageQuery, LocalTokenUsageSnapshot } from './types.ts'
import { backendNotConfigured } from './account-utils.ts'
import { toJsonValue } from './engineering-remote-utils.ts'
import { AGNES_DOCUMENTED_MODELS } from './agnes.ts'
import { logfareSelectionId, NVIDIA_MODELS, SENSENOVA_IMAGE_MODELS, SENSENOVA_MODELS, VYCE_MODEL_PREFIX, VYCE_MODELS } from './managed-catalog-utils.ts'
import type { FreeCodeGoManagedCatalogs } from './managed-catalogs.ts'
import { buildLocalTokenUsageSnapshot } from './token-usage.ts'
import { redactCredentialShapes } from './secret-scan.ts'

/** Fallback balance-credit ladder. The backend's own plan table is the primary
 * source (see `paymentPlans`); this ladder is what the panel shows when that
 * table declares nothing this flow can sell, so a fresh or all-subscription
 * deployment is never left with an empty payment section. The backend still
 * calculates settlement currency, exchange rate, fees, and limits. */
const BALANCE_CREDIT_PLANS: readonly FreeCodeGoPaymentPlan[] = [5, 10, 25, 50, 100, 500].map(amount => ({
  id: `balance-${amount}`,
  name: `US$${amount} Developer Credit`,
  description: 'Permanent FreeCodeGo balance credit',
  price: amount,
  currency: 'USD',
  validityUnit: 'forever',
  features: ['Never expires', 'Stacks with future recharges'],
  productName: 'FreeCodeGo Developer Credit',
  forSale: true,
}))

/**
 * Narrow view of the plugin surface required by the payment, pricing, and
 * token-usage remotes. The plugin satisfies it through its
 * `paymentRemotesHost` accessor.
 */
export interface PaymentRemotesHost {
  readonly ctx: Context
  readonly account: FreeCodeGoAccountCoordinator | undefined
  readonly api: FreeCodeGoApiClient | undefined
  readonly catalogs: FreeCodeGoManagedCatalogs
  readonly restoreAccount: () => Promise<void>
  /** The configured gateway origin; private deployments override the default. */
  readonly gatewayBaseUrl: () => string
  readonly accountGatewayModelPrices: (language: 'zh' | 'en') => Promise<readonly FreeCodeGoGatewayModelPrice[]>
  readonly localGatewayModelPrices: () => Promise<readonly FreeCodeGoGatewayModelPrice[]>
}

/** Validity units that mean a plan never expires.
 *
 * Balance credit is permanent after purchase, so this is the only shape a
 * Harness purchase can actually grant: the checkout is a balance top-up
 * (`plan_id=0` plus an explicit amount), not a subscription grant. A row
 * carrying a term therefore describes something this flow cannot deliver. */
const PERMANENT_VALIDITY_UNITS: ReadonlySet<string> = new Set(['forever', 'permanent', 'lifetime', '永久', '永久有效'])

function isPermanentCreditPlan(plan: FreeCodeGoPaymentPlan): boolean {
  const unit = plan.validityUnit?.trim().toLowerCase()
  return unit !== undefined && PERMANENT_VALIDITY_UNITS.has(unit)
}

/** Saleable balance-credit plans, sourced from the backend's plan table.
 *
 * The administrator's table is the catalogue, so it wins whenever it declares
 * permanent credit — that is how a price, a rename, or a delisting reaches the
 * desktop without a plugin release. Rows carry no explicit kind, so permanence
 * is the discriminator: a plan with a term is a subscription that the hosted
 * web checkout sells, and offering it here would take money through a top-up
 * that could not grant it. When the table declares none, the built-in ladder
 * keeps the section usable. */
export async function paymentPlans(host: PaymentRemotesHost): Promise<readonly FreeCodeGoPaymentPlan[]> {
  if (host.api === undefined || host.account === undefined) throw backendNotConfigured()
  await host.restoreAccount()
  return host.account.withAccessToken(async (accessToken) => {
    const info = await host.api!.getPaymentCheckoutInfo({ accessToken })
    // `checkout-info` is the only producer that also carries the fee and limit
    // fields the checkout needs, and it is where the plan rows are already
    // parsed, so the ladder is replaced rather than fetched twice.
    const permanent = info.plans.filter(isPermanentCreditPlan)
    return permanent.length > 0 ? permanent : BALANCE_CREDIT_PLANS
  })
}

export async function paymentChannels(host: PaymentRemotesHost): Promise<readonly FreeCodeGoPaymentChannel[]> {
  if (host.api === undefined || host.account === undefined) throw backendNotConfigured()
  await host.restoreAccount()
  return host.account.withAccessToken(accessToken => host.api!.getPaymentCheckoutInfo({ accessToken }).then(value => value.channels))
}

/** Return the current account-visible tariff catalog. Account model options
 * provide the enabled whitelist and effective group pricing. */
export async function gatewayModelPrices(host: PaymentRemotesHost, language: 'zh' | 'en'): Promise<readonly FreeCodeGoGatewayModelPrice[]> {
  if (host.api === undefined) throw backendNotConfigured()
  const gateway = await host.accountGatewayModelPrices(language)
  return [...gateway, ...(await host.localGatewayModelPrices())]
}

/**
 * The group's per-image tiers, at the account's effective image rate.
 *
 * An image generation request is settled per generated picture from the group's
 * `image_price_1k/2k/4k` (`BillingService.getImageUnitPrice`, reached whenever
 * the forward carried any image at all), so those are the only numbers that
 * describe the charge — the model's token prices are not a proxy for them.
 *
 * The rate is the *image* rate: independent of the group rate only when the
 * group says so (`groups.image_rate_independent`), which is the same rule the
 * backend settles with (`resolveImageRateMultiplier`) and the one the web model
 * page shows. A group that publishes no tier for a resolution contributes no
 * row, rather than a `US$0.00` that would read as a free picture.
 */
function imagePriceTiers(group: FreeCodeGoModelOptionGroup | undefined, groupRate: number): readonly FreeCodeGoImagePriceTier[] {
  if (group === undefined) return []
  // An independent rate that the backend never stated settles as 0, so read it
  // the same way rather than silently falling back to the group rate.
  const rate = group.imageRateIndependent === true ? (group.imageRateMultiplier ?? 0) : groupRate
  const tiers: FreeCodeGoImagePriceTier[] = []
  const entries: readonly (readonly [string, number | undefined])[] = [
    ['1K', group.imagePrice1K],
    ['2K', group.imagePrice2K],
    ['4K', group.imagePrice4K],
  ]
  for (const [label, base] of entries) {
    if (base === undefined) continue
    const price = base * rate
    tiers.push({ label, price, ...(price === base ? {} : { originalPrice: base }) })
  }
  return tiers
}

export async function accountGatewayModelPrices(host: PaymentRemotesHost, language: 'zh' | 'en'): Promise<readonly FreeCodeGoGatewayModelPrice[]> {
  if (host.account === undefined) return []
  try {
    await host.restoreAccount()
    if (host.account.snapshot().status !== 'authenticated') return []
    return await host.account.withAccessToken(async (accessToken) => {
      // The account-scoped options endpoint is the source of truth for the
      // whitelist. Bootstrap metadata is best-effort and must not hide an
      // enabled account model when it is incomplete or expired.
      // Read the groups beside the models: a row's group is the backend's real
      // name from `groups[]` (`group_name` on the choice is the other backend
      // spelling). Labelling a grouped row with anything local is how a price
      // table ends up inventing a group the account never bought.
      const snapshot = typeof host.api!.getModelOptionsSnapshot === 'function'
        ? await host.api!.getModelOptionsSnapshot({ accessToken })
        : { groups: [], models: await host.api!.getModelOptions({ accessToken }) }
      const options = snapshot.models
      const groupNames = new Map(snapshot.groups.map(group => [group.id, group.name]))
      const groupRows = new Map(snapshot.groups.map(group => [group.id, group]))
      const catalog = await host.api!.getCatalog({ accessToken }).catch(() => undefined)
      const displayNames = new Map((catalog?.models ?? []).map(model => [model.id.toLowerCase(), model.displayName]))
      const ids = [...new Set(options.map(option => option.model.trim()).filter(model => model !== ''))]
      const lookup = new Map((await host.api!.getPublicModelPricingLookup(ids, language).catch(() => [])).map(item => [item.model.toLowerCase(), item]))
      return options.flatMap((option) => {
        const modelId = option.model.trim()
        if (modelId === '') return []
        const displayName = option.displayName ?? displayNames.get(modelId.toLowerCase()) ?? modelId
        return option.options.filter(choice => choice.enabled).map((choice) => {
          const fallback = lookup.get(modelId.toLowerCase())
          const multiplier =  choice.zeroPrice ? 0 : choice.rateMultiplier ?? 1
          const scale = (value: number | undefined): number | undefined => value === undefined ? undefined : value * multiplier
          const billingMode = choice.billingMode ?? (fallback?.billingMode ?? 'token')
          // Image rows are quoted per picture, from the group rather than the
          // model: see `imagePriceTiers` for why the token columns cannot stand
          // in for them.
          const imagePrices = billingMode === 'image' ? imagePriceTiers(groupRows.get(choice.groupId), multiplier) : []
          const originalInput = choice.originalInputPricePerMillion ?? fallback?.inputPricePerMillion
          const originalOutput = choice.originalOutputPricePerMillion ?? fallback?.outputPricePerMillion
          const originalCacheRead = choice.originalCacheReadPricePerMillion ?? fallback?.cacheReadPricePerMillion
          const originalCacheWrite = choice.originalCacheWritePricePerMillion ?? fallback?.cacheWritePricePerMillion
          const originalImageOutput = choice.originalImageOutputPricePerMillion ?? fallback?.imageOutputPricePerMillion
          const currentImageOutput = choice.imageOutputPricePerMillion ?? scale(fallback?.imageOutputPricePerMillion)
          const currentInput = choice.inputPricePerMillion ?? scale(fallback?.inputPricePerMillion)
          const currentOutput = choice.outputPricePerMillion ?? scale(fallback?.outputPricePerMillion)
          const currentCacheRead = choice.cacheReadPricePerMillion ?? scale(fallback?.cacheReadPricePerMillion)
          const currentCacheWrite = choice.cacheWritePricePerMillion ?? scale(fallback?.cacheWritePricePerMillion)
          // The group name has three sources, in the contract's own order: the
          // account's `groups[]` name for the choice's id, the choice's
          // `group_name`, and then the model's real `provider` field. A literal
          // stood here before (`'FreeCodeGo'`), which labelled every ungrouped
          // row with a group no backend ever sent — and, because it was never
          // empty, it also disabled the client's own fallback for a row with no
          // group (its group column shows the source label, "FreeCodeGo
          // gateway"). `''` is therefore the honest last answer: nothing real
          // was left to name the group.
          const groupName = (choice.groupId === undefined ? undefined : groupNames.get(choice.groupId)) ?? choice.groupName ?? option.provider ?? ''
          return {
            modelId, displayName, provider: option.provider ?? 'FreeCodeGo', source: 'gateway' as const,
            groupName,
            ...(choice.protocol === undefined && option.protocol === undefined ? {} : { platform: choice.protocol ?? option.protocol }),
            rateMultiplier: multiplier,
            billingMode,
            currency: choice.currency ?? fallback?.currency ?? 'USD',
            ...(originalInput === undefined ? {} : { originalInputPricePerMillion: originalInput }),
            ...(originalOutput === undefined ? {} : { originalOutputPricePerMillion: originalOutput }),
            ...(originalCacheRead === undefined ? {} : { originalCacheReadPricePerMillion: originalCacheRead }),
            ...(originalCacheWrite === undefined ? {} : { originalCacheWritePricePerMillion: originalCacheWrite }),
            ...(originalImageOutput === undefined ? {} : { originalImageOutputPricePerMillion: originalImageOutput }),
            ...(currentInput === undefined ? {} : { inputPricePerMillion: currentInput }),
            ...(currentOutput === undefined ? {} : { outputPricePerMillion: currentOutput }),
            ...(currentCacheRead === undefined ? {} : { cacheReadPricePerMillion: currentCacheRead }),
            ...(currentCacheWrite === undefined ? {} : { cacheWritePricePerMillion: currentCacheWrite }),
            ...(currentImageOutput === undefined ? {} : { imageOutputPricePerMillion: currentImageOutput }),
            ...(imagePrices.length === 0 ? {} : { imagePrices }),
            ...(option.description === undefined ? {} : { description: option.description }),
          }
        })
      })
    })
  } catch {
    return []
  }
}

/** Price rows for routes that are embedded in the model picker rather than
 * billed by the FreeCodeGo gateway. They are explicitly zero-cost. */
export async function localGatewayModelPrices(host: PaymentRemotesHost): Promise<readonly FreeCodeGoGatewayModelPrice[]> {
  const zero = (modelId: string, displayName: string, provider: FreeCodeGoGatewayModelPrice['source'], groupName: string): FreeCodeGoGatewayModelPrice => ({
    modelId, displayName, provider: groupName, source: provider, groupName,
    rateMultiplier: 0, billingMode: 'token', currency: 'USD',
    inputPricePerMillion: 0, outputPricePerMillion: 0, cacheReadPricePerMillion: 0, cacheWritePricePerMillion: 0,
  })
  const logfareModels = await host.catalogs.logfareModels()
  const rows: FreeCodeGoGatewayModelPrice[] = [
    ...logfareModels.map(model => zero(logfareSelectionId(model.id), `${model.name} · logfare`, 'logfare', 'logfare')),
    ...(await host.catalogs.openCodeFreeModels()).map(model => zero(model.id, model.name, 'opencode', 'OpenCode')),
  ]
  // The model picker always exposes Agnes' documented model family; the
  // adapter marks unavailable rows when the account or API key is missing.
  rows.push(...AGNES_DOCUMENTED_MODELS.map(model => zero(model.id, model.name, 'agnes', 'Agnes AI')))
  // SenseNova's public-beta models are currently free; retain the provider
  // prefix in the display id so similarly named gateway models remain clear.
  rows.push(...SENSENOVA_MODELS.map(model => zero(model.id, `${model.name} · SenseNova`, 'sensenova', 'SenseNova')))
  rows.push(...SENSENOVA_IMAGE_MODELS.map(model => zero(model.id, `${model.name} · SenseNova`, 'sensenova', 'SenseNova')))
  // NVIDIA NIM free-tier models are billed at zero through the user's own key.
  rows.push(...NVIDIA_MODELS.map(model => zero(model.id, `${model.name} · NVIDIA`, 'nvidia', 'NVIDIA')))
  // VyceAI bills the user's own key at the site's published metered prices;
  // its daily check-in credit is what pays for them, so these are not free.
  rows.push(...VYCE_MODELS.map(model => ({
    modelId: `${VYCE_MODEL_PREFIX}${model.id}`,
    displayName: model.name,
    provider: 'VyceAI',
    source: 'vyce' as const,
    groupName: 'VyceAI',
    rateMultiplier: 1,
    billingMode: 'token' as const,
    currency: 'USD',
    inputPricePerMillion: model.inputPricePerMillion,
    outputPricePerMillion: model.outputPricePerMillion,
    // Cache pricing is deliberately left unpublished rather than zeroed: a
    // zero here renders as FREE in the tariff table, which would promise a
    // discount the provider never stated. An absent price reads as a dash.
  })))
  return rows
}

export async function paymentOrders(host: PaymentRemotesHost): Promise<JsonValue> {
  if (host.api === undefined || host.account === undefined) throw backendNotConfigured()
  await host.restoreAccount()
  // Orders are asked for by state instead of paged to.
  //
  // The endpoint is paginated newest-first and one account's newest twenty rows
  // can be expired or cancelled attempts while the order that actually paid sits
  // on the next page — so a caller that lists "my orders" and greps for a paid one
  // reports "no paid orders" for an account that has them (which is exactly what
  // the receipt and invoice surfaces did). Each state the panel renders is
  // therefore requested explicitly and merged into the same envelope the browser
  // already parses, keeping the pending view working while adding the settled one.
  const settled = await host.account.withAccessToken(async (accessToken) => {
    const pages = await Promise.all(ORDER_LIST_STATES.map(status => host.api!.getPaymentOrders({ accessToken, status })))
    const items: JsonValue[] = []
    for (const page of pages) {
      if (page === null || typeof page !== 'object' || Array.isArray(page)) continue
      const list = (page as { readonly items?: unknown }).items
      if (Array.isArray(list)) items.push(...(list as JsonValue[]))
    }
    return items
  })
  // Newest first, by the same field the backend orders on, so the merged list keeps
  // the shape and order callers rely on.
  const ordered = [...settled].sort((left, right) => orderCreatedAt(right) - orderCreatedAt(left))
  return { items: ordered, total: ordered.length, page: 1, page_size: ordered.length, pages: ordered.length === 0 ? 0 : 1 }
}

/**
 * Order states this remote asks the backend for, one request each.
 *
 * `pending` keeps the existing unpaid-order view populated; `paid` and
 * `completed` are what a receipt or an invoice can cite. Expired, cancelled and
 * failed rows are deliberately not requested: the browser has never rendered
 * them, and fetching them would only pad the list with attempts.
 */
const ORDER_LIST_STATES: readonly string[] = ['pending', 'paid', 'completed']

/** One order row's creation time, for merging the per-state lists into one. */
function orderCreatedAt(order: JsonValue): number {
  if (order === null || typeof order !== 'object' || Array.isArray(order)) return 0
  const value = (order as { readonly created_at?: unknown }).created_at
  if (typeof value !== 'string') return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Whether a return URL is one the backend accepts as its own result page.
 *
 * The backend checks that the path *ends* in `/payment/result` on its own
 * origin. This Host used to demand one exact string — `<origin>/payment/result`
 * — which is not what the settings surface sends: it sends the
 * console-mounted page (`<origin>/rootadmin/payment/result`), because the bare
 * path is answered by the marketing site's catch-all with a 200 landing page,
 * so paying users landed on the product page instead of the payment result.
 * The two rules disagreed, and the stricter one won: every 购买 click failed
 * with "return URL must be the canonical payment result page" before an order
 * was ever created, and the purchase looked like a dead button.
 *
 * The rule kept here is therefore "same origin, canonical tail": the origin the
 * Host is configured for, at most one mount segment in front of the canonical
 * path, and nothing that could carry a query, fragment, or traversal.
 *
 * @param gatewayBaseUrl - the configured gateway origin.
 * @param returnUrl - the caller's requested post-payment page.
 */
export function isCanonicalPaymentReturnUrl(gatewayBaseUrl: string, returnUrl: string): boolean {
  const origin = gatewayBaseUrl.replace(/\/+$/, '')
  if (!returnUrl.startsWith(`${origin}/`)) return false
  const path = returnUrl.slice(origin.length + 1)
  return path === 'payment/result' || /^[A-Za-z0-9_-]+\/payment\/result$/u.test(path)
}

/**
 * The desktop checkout configuration: the real per-order limits and the
 * publishable Stripe key.
 *
 * Read through the account token like every other payment call, even though the
 * payload is client-safe: the endpoint is account-scoped, and a checkout surface
 * that cannot read it should say so rather than show a card form that cannot be
 * initialised.
 */
export async function paymentConfig(host: PaymentRemotesHost): Promise<FreeCodeGoPaymentConfig> {
  if (host.api === undefined || host.account === undefined) throw backendNotConfigured()
  await host.restoreAccount()
  return host.account.withAccessToken(accessToken => host.api!.getDesktopPaymentConfig({ accessToken }))
}

/** Create a payment order through the existing FreeCodeGo endpoint. */
export async function paymentCheckout(host: PaymentRemotesHost, planId: number, paymentType: string, returnUrl: string, amount?: number): Promise<FreeCodeGoPaymentOrder> {
  if (host.api === undefined || host.account === undefined) throw backendNotConfigured()
  if (!Number.isSafeInteger(planId) || planId < 0) throw new Error('FreeCodeGo payment plan id must be a non-negative integer')
  if (paymentType.trim() === '') throw new Error('FreeCodeGo payment type is required')
  if (!isCanonicalPaymentReturnUrl(host.gatewayBaseUrl(), returnUrl)) throw new Error(`FreeCodeGo payment return URL must be the canonical payment result page under ${host.gatewayBaseUrl().replace(/\/+$/, '')}`)
  if (amount !== undefined && (!Number.isFinite(amount) || amount <= 0)) throw new Error('FreeCodeGo payment amount must be positive and finite')
  await host.restoreAccount()
  // Creating an order is not idempotent; a 401 must surface instead of being
  // replayed into a duplicate order.
  return host.account.withAccessToken(accessToken => host.api!.createCheckout({ accessToken, planId, paymentType, returnUrl, isMobile: false, ...(amount === undefined ? {} : { amount }) }), undefined, { replayOnUnauthorized: false })
}

/** Poll an existing FreeCodeGo payment order. */
export async function paymentOrder(host: PaymentRemotesHost, orderId: string): Promise<FreeCodeGoPaymentOrder> {
  if (host.api === undefined || host.account === undefined) throw backendNotConfigured()
  if (orderId.trim() === '') throw new Error('FreeCodeGo payment order id is required')
  await host.restoreAccount()
  return host.account.withAccessToken(accessToken => host.api!.getCheckoutOrder({ accessToken, orderId }))
}

export async function paymentVerify(host: PaymentRemotesHost, outTradeNo: string): Promise<FreeCodeGoPaymentOrder> {
  if (host.api === undefined || host.account === undefined) throw backendNotConfigured()
  if (outTradeNo.trim() === '') throw new Error('FreeCodeGo payment out trade number is required')
  await host.restoreAccount()
  return host.account.withAccessToken(accessToken => host.api!.verifyCheckoutOrder({ accessToken, outTradeNo }), undefined, { replayOnUnauthorized: false })
}

export async function paymentCancel(host: PaymentRemotesHost, orderId: string): Promise<{ readonly cancelled: boolean }> {
  if (host.api === undefined || host.account === undefined) throw backendNotConfigured()
  if (orderId.trim() === '') throw new Error('FreeCodeGo payment order id is required')
  await host.restoreAccount()
  // Report the backend's own outcome instead of unconditionally claiming
  // success: cancelCheckoutOrder throws on a rejected cancel, and the
  // re-read order state must reach the client so the UI can tell a pending
  // (unchanged) order from one that actually left the pending set.
  await host.account.withAccessToken(accessToken => host.api!.cancelCheckoutOrder({ accessToken, orderId }), undefined, { replayOnUnauthorized: false })
  const order = await host.account.withAccessToken(accessToken => host.api!.getCheckoutOrder({ accessToken, orderId }))
  return { cancelled: order.state.trim().toLowerCase() !== 'pending' }
}

export async function paymentReceiptEmail(host: PaymentRemotesHost, orderId: string): Promise<{ readonly email: string; readonly message?: string }> {
  if (host.api === undefined || host.account === undefined) throw backendNotConfigured()
  if (orderId.trim() === '') throw new Error('FreeCodeGo payment order id is required')
  await host.restoreAccount()
  return host.account.withAccessToken(accessToken => host.api!.emailCheckoutReceipt({ accessToken, orderId }), undefined, { replayOnUnauthorized: false })
}

/**
 * Fetch a paid order's receipt document for the user to save.
 *
 * Downloading does not depend on the email service the panel's other receipt
 * action needs, so this is the path that works even when mail delivery is
 * unconfigured — and it is the receipt the backend actually issued rather than a
 * look-alike drawn in the client.
 */
export async function paymentReceiptDocument(host: PaymentRemotesHost, orderId: string): Promise<FreeCodeGoReceiptDocument> {
  if (host.api === undefined || host.account === undefined) throw backendNotConfigured()
  if (orderId.trim() === '') throw new Error('FreeCodeGo payment order id is required')
  await host.restoreAccount()
  return host.account.withAccessToken(accessToken => host.api!.downloadCheckoutReceipt({ accessToken, orderId }), undefined, { replayOnUnauthorized: false })
}

/** Return replay-derived local Harness token usage without exposing prompts or tool output. */
export async function tokenUsageLocal(host: PaymentRemotesHost, usageQuery: LocalTokenUsageQuery): Promise<LocalTokenUsageSnapshot> {
  return buildLocalTokenUsageSnapshot(host.ctx, usageQuery)
}

/**
 * Total a per-model table into one window summary.
 *
 * The endpoint reports the token split and leaves the sum to the caller — the
 * same convention the dashboard rollup follows — so a row set that never
 * declares `total_tokens` must not total to zero. The split is only filled in
 * when no row declared a sum, which keeps an endpoint that does report one
 * authoritative.
 */
function reduceModelRows(modelList: readonly unknown[]): Record<string, unknown> {
  const totals = modelList.reduce<Record<string, unknown>>((acc, item) => {
    const row = item !== null && typeof item === 'object' ? item as Record<string, unknown> : {}
    const add = (key: string): void => { const value = row[key]; if (typeof value === 'number' && Number.isFinite(value)) acc[key] = (acc[key] as number | undefined ?? 0) + value }
    for (const key of ['requests', 'input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'total_tokens', 'cost', 'actual_cost']) add(key)
    return acc
  }, {})
  if (totals.total_tokens === undefined) {
    const split = ['input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens']
    totals.total_tokens = split.reduce<number>((sum, key) => sum + (typeof totals[key] === 'number' ? totals[key] : 0), 0)
  }
  return totals
}

/** Gateway billing is intentionally kept as the existing account-scoped snapshot. */
export async function tokenUsageGateway(host: PaymentRemotesHost, days: number): Promise<GatewayUsageSnapshot> {
  const windowDays = Number.isFinite(days) ? Math.max(1, Math.min(90, Math.trunc(days))) : 30
  if (host.api === undefined || host.account === undefined) return { source: 'freecodego-gateway', fetchedAt: Date.now(), days: windowDays, status: 'backend-not-configured', models: [], timeline: [] }
  try {
    await host.restoreAccount()
    const accountSnapshot = host.account.snapshot()
    if (accountSnapshot.status !== 'authenticated') return { source: 'freecodego-gateway', fetchedAt: Date.now(), days: windowDays, status: 'signed-out', models: [], timeline: [], message: '请先登录 FreeCodeGo 账号后查看网关账单。' }
    const end = new Date()
    const start = new Date(end.getTime() - (windowDays - 1) * 24 * 60 * 60_000)
    const iso = (value: Date): string => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    const payload = await host.account.withAccessToken(async (accessToken) => {
      const request = { accessToken, startDate: iso(start), endDate: iso(end) }
      const [summary, models, trend, insights, usage] = await Promise.all([
        host.api!.getUsageDashboardStats({ accessToken }),
        host.api!.getUsageDashboardModels(request),
        host.api!.getUsageDashboardTrend({ ...request, granularity: windowDays <= 1 ? 'hour' : 'day' }),
        host.api!.getUsageDashboardInsights(request),
        host.api!.getUsage({ accessToken, days: windowDays }),
      ])
      return { summary, models, trend, insights, usage }
    })
    const modelsPayload = payload.models as { readonly models?: unknown }
    const trendPayload = payload.trend as { readonly trend?: unknown }
    const insightsPayload = payload.insights as { readonly summary?: unknown; readonly models?: unknown; readonly daily_trend?: unknown }
    const modelRows = modelsPayload.models
    const trendRows = trendPayload.trend
    const summary = windowDays <= 7 ? insightsPayload.summary ?? payload.summary : payload.summary
    const insightModels = insightsPayload.models
    const insightTrend = insightsPayload.daily_trend
    const modelList = Array.isArray(modelRows) && modelRows.length > 0 ? modelRows : Array.isArray(insightModels) ? insightModels : []
    const rangeSummary = modelList.length > 0 ? reduceModelRows(modelList) : summary
    const usageRecord = payload.usage !== null && typeof payload.usage === 'object' && !Array.isArray(payload.usage) ? payload.usage : {}
    const turns = Array.isArray(usageRecord.turns) ? usageRecord.turns : []
    // The rollups travel beside `turns`. The page cannot rebuild them from the
    // turn sample, so they are passed through verbatim rather than reduced here:
    // a browser-side reduce would have to guess which source is authoritative.
    const rows = (value: unknown): readonly JsonValue[] => Array.isArray(value) ? value.map(toJsonValue) : []
    const aggregationSource = typeof usageRecord.aggregation_source === 'string' ? usageRecord.aggregation_source : undefined
    return {
      source: 'freecodego-gateway',
      fetchedAt: Date.now(),
      days: windowDays,
      status: 'available',
      summary: toJsonValue(rangeSummary),
      models: modelList.map(toJsonValue),
      timeline: Array.isArray(trendRows) && trendRows.length > 0 ? trendRows.map(toJsonValue) : Array.isArray(insightTrend) ? insightTrend.map(toJsonValue) : [],
      insights: toJsonValue(payload.insights),
      turns: turns.map(toJsonValue),
      dailyTrend: rows(usageRecord.daily_trend),
      windows: rows(usageRecord.windows),
      threads: rows(usageRecord.threads),
      ...aggregationSource === undefined ? {} : { aggregationSource },
    }
  } catch (error) {
    // The gateway calls carry the account access token, so a failure it echoed
    // back would otherwise land in the usage panel as a live credential.
    const message = redactCredentialShapes(error instanceof Error ? error.message : String(error))
    return { source: 'freecodego-gateway', fetchedAt: Date.now(), days: windowDays, status: 'error', models: [], timeline: [], message }
  }
}

export async function tokenUsageCurrentSession(host: PaymentRemotesHost, sessionId: string): Promise<LocalTokenUsageSnapshot | undefined> {
  if (typeof sessionId !== 'string' || sessionId.trim() === '' || sessionId.length > 256) throw new Error('token usage session id is invalid')
  const snapshot = await buildLocalTokenUsageSnapshot(host.ctx, { sessionId: sessionId.trim(), startAt: 0, endAt: Date.now() })
  return snapshot.currentSession === undefined ? undefined : snapshot
}
