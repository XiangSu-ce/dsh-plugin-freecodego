/**
 * Host-only WorkBuddy International (workbuddy.ai) provider.
 *
 * The Settings card owns sign-in; this module owns everything after it. A
 * browser authorization (or a desktop-app import) lands a token pair in the
 * Host vault, and the pool behind that vault becomes a real provider: the live
 * route directory plus the adapter that serves it. The product document prices
 * each route, so the directory is listed in full — the free tier is what the
 * pool serves for nothing, and a metered sibling is what a user may deliberately
 * pay for, which is why it is listed (default-off) instead of hidden.
 *
 * Endpoints, all on the product host:
 *
 * - catalog `GET  /v3/config`                      — the product document; the
 *   gateway splits it by request shape, so this read carries the App-style
 *   headers and the CLI user agent.
 * - chat    `POST /v2/chat/completions`            — SSE, Bearer, `stream: true`.
 * - refresh `POST /v2/plugin/auth/token/refresh`   — the rotated pair lives in
 *   the plugin vault; the desktop app's own auth file is never written.
 *
 * Two upstream rules shape the code below:
 *
 * 1. Free credits are per account, not per model, so a spent account must rotate
 *    to the next one inside a single turn; only an exhausted pool fails.
 * 2. The international chat endpoint rejects a body whose first message is not
 *    `system` (HTTP 400, code 11128), which {@link prepareWorkBuddyChatBody}
 *    guarantees even for a caller that sent no system prompt.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/workbuddy-intl
 */

import { randomUUID } from 'node:crypto'
import { credentialRef, type CredentialProvider, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { attributionHeaders, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { serializeRequest, translate } from './openai-wire.ts'
import { parseSse } from './wire-shared.ts'
import { redactCredentialShapes } from './secret-scan.ts'
import { asNumber as number, asRecord as record, asString as string } from './untrusted-json.ts'
import { llmCodeForUpstreamStatus, upstreamStatusCategory, type UpstreamStatusCategory } from './upstream-status-code.ts'
import { assertSurfaceIdentity, surfaceIdentityHeaders, type RequestIdentityTable, type SurfaceDeclaration } from './request-identity.ts'
import { isHttpUrl } from './system-browser.ts'
import type { WorkBuddyCreditPackage, WorkBuddyCredits, WorkBuddyInternationalAccount, WorkBuddyInternationalModel } from './types.ts'
import {
  WORKBUDDY_INTL_BASE_URL,
  WORKBUDDY_INTL_BILLING_URL,
  WORKBUDDY_INTL_CATALOG_TIMEOUT_MS,
  WORKBUDDY_INTL_CATALOG_USER_AGENT,
  WORKBUDDY_INTL_CHAT_URL,
  WORKBUDDY_INTL_FREE_PACKAGE_CODES,
  WORKBUDDY_INTL_MODELS_URL,
  WORKBUDDY_INTL_PAID_PACKAGE_CODES,
  WORKBUDDY_INTL_PRODUCT_CODE,
  WORKBUDDY_INTL_RESOURCE_FREE_URL,
  WORKBUDDY_INTL_RESOURCE_PAID_URL,
  WORKBUDDY_INTL_RESOURCE_SUMMARY_URL,
  WORKBUDDY_INTL_TOKEN_REFRESH_URL,
  WORKBUDDY_LOGIN_PENDING_CODE,
} from './managed-catalog-utils.ts'

/** Host-only credential slot for the WorkBuddy International account pool. */
export const WORKBUDDY_INTL_STORE_REF: CredentialRef = credentialRef('WORKBUDDY_INTL_STORE')

// `WORKBUDDY_INTL_CHAT_URL` is imported from `managed-catalog-utils.ts`, where
// every other WorkBuddy route already lives. It used to be declared here as well,
// which made two copies of one endpoint: a route change made in the wrong file
// would leave that copy naming a path nothing reads. The list is the place to
// edit, and this module only consumes it.

/** The CLI identity the product host expects on every request. */
const WORKBUDDY_USER_AGENT = 'CLI/2.63.2 CodeBuddy/2.63.2'
/**
 * The chat route's own identity, which is the desktop client's and not the CLI's.
 *
 * `/v2/chat/completions` is served to the WorkBuddy desktop build, and that build
 * names itself in a header family the other routes do not carry: the attribution
 * name, the IDE identity, and the conversation ids. The credits and catalog routes
 * are the `/plugin` surface and keep the CLI User-Agent above — a request that
 * mixes the two is the shape the gateway rejects rather than serves.
 */
const WORKBUDDY_ATTRIBUTION_NAME = 'WorkBuddy'
/** The desktop build whose header family this module speaks. */
const WORKBUDDY_CLIENT_VERSION = '5.5.2'
/**
 * The `X-Product-Code` both the IDE and the plugin surfaces send.
 *
 * Not the billing body's `ProductCode` (`{@link WORKBUDDY_INTL_PRODUCT_CODE}`,
 * the metering package id): this one names the *product* to the header-filtering
 * gateway, and the two are read by different services.
 */
const WORKBUDDY_IDE_PRODUCT_CODE = 'workbuddy'
/**
 * `X-Domain`: the host this request itself talks to.
 *
 * Never the credential's `domain`, which is a snapshot of the site the account
 * signed in at — an account imported from an older build still carries a host the
 * gateway no longer serves (the desktop client moved on), and a request whose
 * declared identity and destination disagree is refused. The credential's value
 * is only a fallback for a build that names no host at all.
 */
const WORKBUDDY_INTL_DOMAIN: string = 'www.workbuddy.ai'
/**
 * The desktop User-Agent, per model family.
 *
 * The gateway attributes a turn to a client form, and the two forms are not
 * interchangeable: the international model lines are served to the international
 * build, while the domestic lines (`glm`, `hy`, `kimi`, `minimax`) are served to
 * the domestic one. One User-Agent for every route is what makes a turn look like
 * it came from a client that does not exist.
 */
const WORKBUDDY_CHAT_USER_AGENT_INTL = 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2'
const WORKBUDDY_CHAT_USER_AGENT_CN = 'WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2'
/** Model-id prefixes the domestic client form serves. */
const WORKBUDDY_CHAT_CN_MODEL_PREFIXES: readonly string[] = ['glm-', 'hy', 'kimi-', 'minimax-']

/**
 * The User-Agent one route's chat request carries.
 *
 * First match wins, and an unknown prefix keeps the international form: that is
 * the shape a newly published route is reached through, where the domestic form
 * would name a client the gateway does not know.
 * @param model - the route id the request asks for.
 * @returns the User-Agent string for that route's client form.
 */
export function workBuddyUserAgent(model: string): string {
  return WORKBUDDY_CHAT_CN_MODEL_PREFIXES.some(prefix => model.startsWith(prefix))
    ? WORKBUDDY_CHAT_USER_AGENT_CN
    : WORKBUDDY_CHAT_USER_AGENT_INTL
}

/**
 * The `X-Domain` header for one account, as a one-key map.
 *
 * `X-No-*` is the upstream's own "this field is absent" spelling: sending the
 * header empty is rejected, so a host nothing can name is declared missing
 * instead of guessed.
 * @param credentialDomain - the login-site snapshot carried by the account.
 * @returns the header map to spread into a request.
 */
function domainHeader(credentialDomain: string | undefined): Record<string, string> {
  const host = WORKBUDDY_INTL_DOMAIN !== '' ? WORKBUDDY_INTL_DOMAIN : credentialDomain
  return host === undefined || host === '' ? { 'x-no-department-info': '1' } : { 'x-domain': host }
}

/**
 * The sign-in page's URL, carrying the two parameters the desktop client adds.
 *
 * The gateway mints the `authUrl` and the browser sign-in binds the issued
 * tokens to the `state` inside it, so nothing here is rebuilt: `version` states
 * the build that opened the page and `loginSessionId` is a per-attempt id the
 * server keeps for its own log trail. It validates nothing, which is exactly why
 * a fresh value per attempt is the correct one — and why a URL this side
 * reconstructed instead of extended (losing `platform` or rewriting the state)
 * is the "still signing in" loop the poll exists to end.
 * @param authUrl - the URL the product issued for this attempt.
 * @returns the same URL with `version` and `loginSessionId` set.
 */
export function decorateWorkBuddyLoginUrl(authUrl: string): string {
  try {
    const url = new URL(authUrl)
    url.searchParams.set('version', WORKBUDDY_CLIENT_VERSION)
    url.searchParams.set('loginSessionId', randomUUID())
    return url.toString()
  } catch {
    // An unparsable URL is the caller's error to report against the server's own
    // bytes; decorating must not replace it with a different one.
    return authUrl
  }
}

/** The deployment kind both products are served under on the plugin surface. */
const WORKBUDDY_DEPLOYMENT_TYPE = 'SaaS'

/**
 * The three surfaces one pool serves, each with its own identity.
 *
 * They are three requests to one host, and the host tells them apart by what
 * they call themselves: the chat route is the desktop client's, the credits and
 * catalog routes are the plugin surface's, and a header from one family on the
 * other's request is worse than a missing one — `X-Product: SaaS` on a chat turn
 * files it under no product at all, and `WorkBuddy` on a credits call names a
 * deployment the metering route does not serve.
 *
 * This table is the single place those identities are written down, because
 * their last form was three literals spread across three methods, and the drift
 * between them was invisible until a turn stopped being answered: the same value
 * declared once per caller is a value that can disagree with itself.
 */
export type WorkBuddyRequestSurface = 'chat' | 'credits' | 'catalog'

/** One surface's declaration: what it calls itself and what it must carry. */
export interface WorkBuddySurfaceIdentity {
  /** `X-Product`: the deployment kind, or the attribution name on the chat route. */
  readonly product: string
  /** `X-Product-Code`, naming the product to the header-filtering gateway. */
  readonly productCode: string
  /** The `Accept` this surface asks with. */
  readonly accept: string
  /** The `Content-Type` when the request carries a body; a read states none. */
  readonly contentType?: string
  /**
   * Which User-Agent the surface speaks as: the per-model-family desktop one, the
   * CLI one the plugin surface uses, or the App-shaped one the catalog read needs.
   */
  readonly userAgent: 'model' | 'cli' | 'catalog'
  /** Headers this surface alone sends. */
  readonly extraHeaders: Readonly<Record<string, string>>
  /**
   * Every header a request on this surface has to carry. An entry that is a list
   * is a choice: one of its names must be present (`X-No-*` declares a field the
   * account never captured, which is not the same as omitting the header).
   */
  readonly required: readonly (string | readonly string[])[]
}

/** The identity table, one entry per surface. */
const WORKBUDDY_SURFACES: Readonly<Record<WorkBuddyRequestSurface, WorkBuddySurfaceIdentity>> = {
  chat: {
    product: WORKBUDDY_ATTRIBUTION_NAME,
    productCode: WORKBUDDY_IDE_PRODUCT_CODE,
    accept: 'text/event-stream',
    contentType: 'application/json',
    userAgent: 'model',
    extraHeaders: {
      'x-agent-purpose': 'conversation',
      'x-ide-name': WORKBUDDY_ATTRIBUTION_NAME,
      'x-ide-type': WORKBUDDY_ATTRIBUTION_NAME,
      'x-ide-version': WORKBUDDY_CLIENT_VERSION,
    },
    required: [
      'authorization', 'content-type', 'accept', 'origin', 'referer', 'user-agent', 'x-requested-with',
      'x-product', 'x-product-code', 'x-domain', ['x-user-id', 'x-no-user-id'],
      ['x-enterprise-id', 'x-no-enterprise-id'], 'x-agent-purpose', 'x-ide-name', 'x-ide-type', 'x-ide-version',
      'x-conversation-id', 'x-conversation-message-id', 'x-conversation-request-id',
    ],
  },
  credits: {
    product: WORKBUDDY_DEPLOYMENT_TYPE,
    productCode: WORKBUDDY_IDE_PRODUCT_CODE,
    accept: 'application/json, text/plain, */*',
    contentType: 'application/json',
    userAgent: 'cli',
    // The product's own plans-and-usage page always sends this, and the gateway
    // treats its absence as an unknown client on some routes.
    extraHeaders: { 'x-client-platform': 'web' },
    required: [
      'authorization', 'content-type', 'accept', 'origin', 'referer', 'user-agent', 'x-requested-with',
      'x-product', 'x-product-code', 'x-domain', 'x-client-platform', ['x-user-id', 'x-no-user-id'],
      ['x-enterprise-id', 'x-no-enterprise-id'],
    ],
  },
  catalog: {
    product: WORKBUDDY_DEPLOYMENT_TYPE,
    productCode: WORKBUDDY_IDE_PRODUCT_CODE,
    accept: 'application/json',
    userAgent: 'catalog',
    extraHeaders: {},
    required: [
      'authorization', 'accept', 'origin', 'referer', 'user-agent', 'x-requested-with',
      'x-product', 'x-product-code', 'x-domain', ['x-user-id', 'x-no-user-id'],
      ['x-enterprise-id', 'x-no-enterprise-id'],
    ],
  },
}

/**
 * One surface's declaration, for callers that have to state what it sends.
 * @param surface - the request surface to describe.
 * @returns the surface's identity declaration.
 */
export function workBuddySurfaceIdentity(surface: WorkBuddyRequestSurface): WorkBuddySurfaceIdentity {
  return WORKBUDDY_SURFACES[surface]
}

/**
 * The three ids a chat turn is filed under, per turn.
 *
 * Generated rather than declared: they name *this* turn (a fresh message and
 * request id each time), while the conversation id is the one value that repeats
 * across a conversation — which is why it is also the prefix-cache key.
 * @param conversationId - the conversation the turn belongs to.
 * @returns the per-turn conversation headers.
 */
function conversationHeaders(conversationId: string): Record<string, string> {
  return {
    'x-conversation-id': conversationId,
    'x-conversation-message-id': randomUUID(),
    'x-conversation-request-id': randomUUID(),
  }
}

/**
 * One surface's declaration in the shared shape: the fixed half of what it sends.
 *
 * Derived from {@link WORKBUDDY_SURFACES} rather than written out again, so the
 * identity a request is *checked* against cannot drift from the identity it is
 * *built* from — which is the whole failure mode the table exists to end.
 * @param surface - the surface to declare.
 * @returns the surface's fixed headers and the names its requests must carry.
 */
function declaredSurface(surface: WorkBuddyRequestSurface): SurfaceDeclaration {
  const identity = WORKBUDDY_SURFACES[surface]
  return {
    headers: {
      accept: identity.accept,
      ...(identity.contentType === undefined ? {} : { 'content-type': identity.contentType }),
      'x-product': identity.product,
      'x-product-code': identity.productCode,
      ...identity.extraHeaders,
      // The chat surface's User-Agent is resolved per model family, so the caller
      // supplies it; the other two are fixed values and belong in the table.
      ...(identity.userAgent === 'model'
        ? {}
        : { 'user-agent': identity.userAgent === 'catalog' ? WORKBUDDY_INTL_CATALOG_USER_AGENT : WORKBUDDY_USER_AGENT }),
    },
    required: identity.required,
  }
}

/**
 * The three identities in the shared shape, for the guard every request passes.
 *
 * A missing header is not a cosmetic problem on this host: the gateway answers
 * with a 400 or files the turn under nothing, so the failure that reaches the log
 * is a refusal whose cause is one absent name. Naming them here is what makes
 * that cause the error message instead of the symptom.
 */
export const workBuddyIdentity: RequestIdentityTable<WorkBuddyRequestSurface> = {
  code: 'WORKBUDDY',
  surfaces: {
    chat: declaredSurface('chat'),
    credits: declaredSurface('credits'),
    catalog: declaredSurface('catalog'),
  },
}

/**
 * The `reasoning_effort` value one tier travels as.
 *
 * `xhigh` is this plugin's own name for the tier the wire spells `max`, and the
 * serializer applies the same rewrite when the caller picks an effort; this one
 * exists so a tier chosen as a fallback is spelled the same way.
 * @param tier - the declared tier.
 * @returns the wire spelling.
 */
function reasoningWireEffort(tier: WorkBuddyReasoningTier): string {
  return tier === 'xhigh' ? 'max' : tier
}

/**
 * Apply the reasoning switch a DeepSeek route on this host needs, and only there.
 *
 * A DeepSeek route is not made to think by `thinking` alone: that flag and an
 * effort tier are one switch, and a request carrying neither is answered with an
 * empty `reasoning_content` however the route is described. So the flag travels
 * on every DeepSeek turn, and the tier is filled in when the caller stated none
 * — from the product's own default for that route, then `high`, then the lowest
 * tier it accepts.
 *
 * Two answers are deliberately left alone. `off` is a decision, not an absence:
 * a route whose ladder offers it keeps reasoning off, because a switch that turns
 * itself back on is worse than a route that never reasons. And a tier the route's
 * own ladder does not list is replaced rather than sent, since an unsupported
 * level is a refused request (`400`) — while a route that declares no ladder at
 * all leaves the caller's word alone, because nothing here can judge it.
 * @param body - the serialized chat body.
 * @param model - the route the request asks for.
 * @param declared - the ladder the live document declares for that route, when it declares one.
 * @param requestedEffort - the tier the caller chose, `off` included; absent when it chose none.
 * @returns the body with the DeepSeek reasoning switch applied.
 */
export function prepareWorkBuddyReasoning(
  body: Record<string, unknown>,
  model: string,
  declared?: { readonly efforts: readonly WorkBuddyReasoningTier[]; readonly defaultEffort: string },
  requestedEffort?: string,
): Record<string, unknown> {
  if (!/^deepseek/iu.test(model.trim())) return body
  if (requestedEffort === 'off') return body
  const efforts = declared?.efforts ?? []
  const ladder = efforts.map(reasoningWireEffort)
  const stated = declared?.defaultEffort
  const declaredFallback = stated !== undefined && efforts.some(tier => tier === stated)
    ? reasoningWireEffort(stated as WorkBuddyReasoningTier)
    : undefined
  const fallback = declaredFallback ?? ladder.find(effort => effort === 'high') ?? ladder[0]
  const enabled = { ...body, thinking: { type: 'enabled' } }
  // The caller's own tier stands whenever the route accepts it, or whenever the
  // route declared no ladder to judge it by.
  if (requestedEffort !== undefined) {
    return ladder.length === 0 || ladder.includes(requestedEffort) ? enabled : { ...enabled, reasoning_effort: fallback }
  }
  return fallback === undefined ? enabled : { ...enabled, reasoning_effort: fallback }
}
/** Refresh this long before the recorded expiry so a stream never dies mid-turn. */
const WORKBUDDY_INTL_REFRESH_BUFFER_MS = 5 * 60_000
const WORKBUDDY_INTL_MODELS_CACHE_TTL_MS = 5 * 60_000
const WORKBUDDY_INTL_CHAT_TIMEOUT_MS = 120_000
/** Waiting times applied when the upstream does not state its own. */
const WORKBUDDY_INTL_SHORT_COOLDOWN_MS = 5 * 60_000
const WORKBUDDY_INTL_CREDIT_COOLDOWN_MS = 30 * 60_000
const WORKBUDDY_INTL_RATE_COOLDOWN_MS = 60_000

/**
 * How long an account is parked when the upstream states no delay of its own.
 *
 * Read from the shared status category rather than compared against the status
 * again, because parking is a statement about the *account* and only `401` makes
 * that statement about its credential: `402`/`403` are a spent budget and a plan
 * gate, and waiting refills neither, so the account takes the credit park while the
 * walk meets another one. A `429` is a one-minute turn. A `5xx` and a status no rule
 * claims name nothing the account can change, so they take the short park and leave
 * the decision to the pool.
 *
 * This ladder used to read `402 → credit, 429 → rate, everything else → auth`, which
 * parked a `403` on the *sign-in* window — the same status the error code one screen
 * away reports as `RATE_LIMIT`, because the credential it merely declined to accept
 * on this route was still good.
 */
const WORKBUDDY_INTL_COOLDOWN_BY_CATEGORY: Readonly<Record<UpstreamStatusCategory, number>> = {
  auth: WORKBUDDY_INTL_SHORT_COOLDOWN_MS,
  quota: WORKBUDDY_INTL_CREDIT_COOLDOWN_MS,
  'rate-limit': WORKBUDDY_INTL_RATE_COOLDOWN_MS,
  server: WORKBUDDY_INTL_SHORT_COOLDOWN_MS,
  other: WORKBUDDY_INTL_SHORT_COOLDOWN_MS,
}
/**
 * The context window this product actually serves, per the operator (2026-09-25).
 *
 * It is a ceiling, not a fallback, and it is deliberately **below** what the
 * catalog advertises: the live `/v3/config` document gives 9 of 25 routes
 * `maxInputTokens` 1,000,000 with `maxAllowedSize` 1,000,000 beside an
 * `contextWindow` of `{"defaultLength":300000,"supportedLengths":[300000,1000000]}`,
 * and the rest between 176,000 and 272,000. Reading that largest number is what
 * this connector used to do, and it is the direction that breaks: compaction is
 * sized against this value, so an over-large window lets a conversation grow past
 * what the service serves and the route starts refusing mid-session with nothing
 * local to warn anyone.
 *
 * A route that publishes **less** keeps its own smaller number — `hy3` at 192,000
 * and `fast-model` at 200,000 are real ceilings. That is what {@link workBuddyContextWindow}
 * is for.
 */
const WORKBUDDY_INTL_CONTEXT_WINDOW = 264_000

/**
 * The window one WorkBuddy route runs at: its own published size when that is
 * smaller, and this product's real ceiling otherwise.
 *
 * A single answer for every route would be wrong in one direction or the other —
 * the catalog genuinely serves 176,000 for some rows and advertises 1,000,000 for
 * others — so the two facts are combined rather than chosen between: **the smaller
 * one wins**, because compaction is sized against this number and only the
 * over-large direction lets a prompt outgrow the service.
 * @param published - the catalog's own window for the route, when it stated one.
 * @returns the window a turn is sized against.
 */
export function workBuddyContextWindow(published: number | undefined): number {
  return published === undefined ? WORKBUDDY_INTL_CONTEXT_WINDOW : Math.min(published, WORKBUDDY_INTL_CONTEXT_WINDOW)
}
const WORKBUDDY_INTL_DEFAULT_MAX_TOKENS = 32_000
/** A credit package counts as expiring soon inside this window. */
export const WORKBUDDY_CREDIT_EXPIRING_SOON_MS = 7 * 24 * 3_600_000
const WORKBUDDY_INTL_BILLING_TIMEOUT_MS = 15_000

/**
 * The one route WorkBuddy documents as permanently free.
 *
 * The product document is the honest source of availability and is read live on
 * every cache miss; this seed exists only for the case where the document cannot
 * be read yet (brand-new account, gateway hiccup) and the pool should still be
 * usable. The plugin shipped this same `auto` route as its zero-price entry
 * before the live catalog existed.
 */
const WORKBUDDY_INTL_FALLBACK_ROUTE: WorkBuddyInternationalModel = {
  id: 'auto',
  displayName: 'WorkBuddy Auto',
  provider: 'workbuddy',
  supportsImages: false,
  rateMultiplier: 0,
}

/** The system line prepended when a caller sends no system message. */
const WORKBUDDY_SYSTEM_PREAMBLE = 'You are a helpful assistant.'

/** A failed upstream call after every account was tried. */
export class WorkBuddyIntlError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`WorkBuddy upstream request failed (HTTP ${status})${detail === '' ? '' : `: ${detail}`}`)
    this.name = 'WorkBuddyIntlError'
  }
}

/**
 * The reason to report for a step that failed inside the pool walk.
 *
 * A nested `WorkBuddyIntlError` already frames its own status in `.message`, so
 * using that message as the outer error's detail produced "… failed (HTTP 401):
 * … failed (HTTP 401): refresh returned no token" — the same sentence twice,
 * with the upstream text that matters furthest from the front. Its `.detail` is
 * that text, already redacted when the error was built.
 */
function failureDetail(error: unknown): string {
  if (error instanceof WorkBuddyIntlError) return error.detail
  return redact(error instanceof Error ? error.message : String(error))
}

/**
 * Upstream text on its way into a `WorkBuddyIntlError` or a parked-account
 * reason, so it can reach a UI error and a transcript.
 *
 * The credential shapes are the shared scanner's job. This provider used to
 * carry two private rules of its own — a bearer token and the
 * `access_token`/`refresh_token` pair — and the pair was where the drift showed:
 * it named the two tokens *this* provider deals in, so a message echoing any
 * other provider's shape passed them untouched while the neighbouring surface
 * masked it. Only the formatting stays local: an upstream body is unbounded and
 * multi-line, and this text becomes a turn's error message.
 */
function redact(value: string): string {
  return redactCredentialShapes(value)
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 512)
}
/** Read an expiry that may arrive in epoch seconds, epoch ms, or ISO text. */
function parseExpiry(value: unknown): number | undefined {
  const numeric = number(value)
  if (numeric !== undefined) return numeric > 1e12 ? numeric : numeric * 1_000
  const text = string(value)
  if (text === undefined) return undefined
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : undefined
}
/** `credits: "x0.00"` and its relatives are the multiplier spelling upstream uses. */
function rateMultiplierOf(credits: string | undefined, explicit: number | undefined): number | undefined {
  if (explicit !== undefined) return explicit
  if (credits === undefined) return undefined
  const match = /^x?\s*([0-9]+(?:\.[0-9]+)?)$/u.exec(credits.trim())
  return match === null ? undefined : Number(match[1])
}

/**
 * The identity one stored row is addressed by.
 *
 * A row carries `id` when this plugin wrote it, but older vaults hold rows with
 * only the tokens (and sometimes an address), so the reader derives an identity
 * from the fields it does have. Every writer that has to find a row again — the
 * token rotation, the credit sweep — must resolve ids through this one function:
 * the id a caller was handed is the id that names the row it came from, and a
 * second, slackened matcher is how one account's tokens ended up overwriting a
 * different account's.
 *
 * `undefined` means the row cannot be addressed at all (no id, no uid, no
 * address, no token).
 * @param row - the stored account row.
 * @returns the addressable id, or `undefined` when the row carries none.
 */
export function workBuddyIntlAccountId(row: Record<string, unknown>): string | undefined {
  return string(row.id) ?? string(row.uid) ?? string(row.email) ?? ((): string | undefined => {
    const accessToken = string(row.accessToken)
    return accessToken === undefined ? undefined : `workbuddy-${accessToken.slice(-12)}`
  })()
}

/**
 * Read the account pool. Cheap and offline: the picker and the Settings card
 * ask on every render, so this never touches the network.
 * @returns the work Buddy International Account rows, in backend order.
 * @param credentials - the credential provider, or `undefined` before it mounts.
 */
export async function readWorkBuddyIntlAccounts(credentials: CredentialProvider | undefined): Promise<readonly WorkBuddyInternationalAccount[]> {
  const resolved = await credentials?.resolve(WORKBUDDY_INTL_STORE_REF)
  if (resolved?.value === undefined) return []
  try {
    const parsed = record(JSON.parse(resolved.value))
    const rows = Array.isArray(parsed.accounts) ? parsed.accounts : []
    return rows.map((item) => {
      const row = record(item)
      const accessToken = string(row.accessToken)
      if (accessToken === undefined) return undefined
      const email = string(row.email)
      const refreshToken = string(row.refreshToken)
      const uid = string(row.uid)
      const domain = string(row.domain)
      const enterpriseId = string(row.enterpriseId)
      const creditRemaining = number(row.creditRemaining)
      const creditUsed = number(row.creditUsed)
      const creditExpiresAt = number(row.creditExpiresAt)
      const creditCheckedAt = number(row.creditCheckedAt)
      const creditError = string(row.creditError)
      const id = workBuddyIntlAccountId(row)
      if (id === undefined) return undefined
      return {
        id,
        ...(email === undefined ? {} : { email }),
        accessToken,
        ...(refreshToken === undefined ? {} : { refreshToken }),
        expiresAt: parseExpiry(row.expiresAt) ?? 0,
        creditTotal: number(row.creditTotal) ?? 0,
        lastChecked: number(row.lastChecked) ?? 0,
        ...(uid === undefined ? {} : { uid }),
        ...(domain === undefined ? {} : { domain }),
        ...(enterpriseId === undefined ? {} : { enterpriseId }),
        ...(creditRemaining === undefined ? {} : { creditRemaining }),
        ...(creditUsed === undefined ? {} : { creditUsed }),
        ...(creditExpiresAt === undefined ? {} : { creditExpiresAt }),
        ...(creditCheckedAt === undefined ? {} : { creditCheckedAt }),
        ...(creditError === undefined ? {} : { creditError }),
      } satisfies WorkBuddyInternationalAccount
    }).filter((account): account is WorkBuddyInternationalAccount => account !== undefined)
  } catch {
    // A malformed store is treated as signed out; the card can re-import.
    return []
  }
}

/**
 * The account the user picked, as the vault recorded it.
 *
 * Three writers set `activeAccountId` (the import, the removal, and the card's
 * "use this account") and nothing read it back: {@link WorkBuddyIntlClient.chat}
 * rotated from its own cursor and the status recomputed the account from the
 * first row with a token, so the selection was a field with no consumer and the
 * control appeared to do nothing. It is a *preference* — a caller must still be
 * ready for that row to be absent, spent, or parked.
 * @param credentials - the credential provider, or `undefined` before it mounts.
 * @returns the selected account id, or `undefined` when none is recorded.
 */
export async function readWorkBuddyIntlActiveId(credentials: CredentialProvider | undefined): Promise<string | undefined> {
  const resolved = await credentials?.resolve(WORKBUDDY_INTL_STORE_REF)
  if (resolved?.value === undefined) return undefined
  try {
    return string(record(JSON.parse(resolved.value)).activeAccountId)
  } catch {
    // Same reading as the pool itself: an unreadable store selects nothing.
    return undefined
  }
}

/**
 * The pool with the selected account moved to the front.
 *
 * A missing or already-first selection leaves the order alone, which is what
 * keeps the pool's own rotation intact when nobody has chosen.
 */
function selectedFirst(pool: readonly WorkBuddyInternationalAccount[], selected: string | undefined): readonly WorkBuddyInternationalAccount[] {
  if (selected === undefined) return pool
  const index = pool.findIndex(account => account.id === selected)
  return index <= 0 ? pool : [...pool.slice(index), ...pool.slice(0, index)]
}

/**
 * One time-boxed discount from the product document's `modelPromotions`.
 *
 * Only the shape the document has actually been observed to use is modelled —
 * an enabled promotion whose `discount.displayMode` is `replace` — because the
 * other display modes have no unambiguous price rule. A promotion that does not
 * match is dropped rather than guessed at.
 */
interface WorkBuddyIntlPromotion {
  readonly start: number
  readonly end: number
  readonly factor: number
  readonly label: string
  readonly priority: number
}

/**
 * A route plus the promotions that cover it.
 *
 * Promotions are deliberately *not* folded into the rate at parse time: the
 * directory is cached, and a cached "free now" would keep claiming a discount
 * after `validUntil` had passed. {@link isFreeRoute} re-evaluates them on every
 * read instead.
 */
export interface WorkBuddyIntlRoute extends WorkBuddyInternationalModel {
  readonly promotions?: readonly WorkBuddyIntlPromotion[]
}

/** Read the promotions covering one route out of the document's own array. */
function promotionsFor(value: unknown, model: string): readonly WorkBuddyIntlPromotion[] | undefined {
  if (!Array.isArray(value)) return undefined
  const promotions: WorkBuddyIntlPromotion[] = []
  for (const item of value) {
    const row = record(item)
    if (row.enabled !== true) continue
    const modelIds = Array.isArray(row.modelIds) ? row.modelIds : []
    if (!modelIds.some(id => id === model)) continue
    const discount = record(row.discount)
    if (discount.displayMode !== 'replace') continue
    const schedule = record(row.schedule)
    const start = parseExpiry(schedule.validFrom) ?? NaN
    const end = parseExpiry(schedule.validUntil) ?? NaN
    const factor = number(discount.factor)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    if (factor === undefined || factor < 0) continue
    promotions.push({
      start,
      end,
      factor,
      label: string(record(row.badge).label) ?? '',
      priority: number(row.priority) ?? 0,
    })
  }
  return promotions.length === 0 ? undefined : promotions
}

/** The promotion in force for a route, highest priority winning. */
function activePromotion(route: WorkBuddyIntlRoute, now: number): WorkBuddyIntlPromotion | undefined {
  const promotions = route.promotions
  if (promotions === undefined || promotions.length === 0) return undefined
  return [...promotions].sort((a, b) => b.priority - a.priority).find(promotion => now >= promotion.start && now < promotion.end)
}

/**
 * Whether a route costs nothing right now.
 *
 * A route with no promotions is trusted at its own rate. A route that *does*
 * carry promotions is only free while one of them is in force with factor 0:
 * the document bakes the discounted value into `credits` while a promotion runs,
 * so an expired one would otherwise advertise a discount that has ended — the
 * worst case of which is telling the user a paid model is free.
 * @param route - the route to price.
 * @param now - the time the promotion is evaluated at.
 * @returns whether the route costs nothing right now.
 */
export function isFreeRoute(route: WorkBuddyIntlRoute, now = Date.now()): boolean {
  const promotion = activePromotion(route, now)
  if (promotion !== undefined) return promotion.factor === 0
  return (route.promotions?.length ?? 0) === 0 && route.rateMultiplier === 0
}

/**
 * The `cli` allowlist carried by the product document, when it has one.
 *
 * The product document nests its agent list under `agent`; the CLI document and
 * older builds put it at the top level, so both spellings are read. The list
 * names what this account may actually be given, so a document without a `cli`
 * entry (a shape we do not know) filters nothing rather than emptying the
 * directory.
 */
function allowedRoutes(data: Record<string, unknown>): ReadonlySet<string> | undefined {
  const agent = record(data.agent)
  const candidates = Array.isArray(data.agents) ? data.agents : Array.isArray(agent.agents) ? agent.agents : undefined
  if (candidates === undefined) return undefined
  const allowed = new Set<string>()
  for (const entry of candidates) {
    const row = record(entry)
    if (row.name !== 'cli') continue
    for (const model of Array.isArray(row.models) ? row.models : []) {
      const id = typeof model === 'string' ? string(model) : string(record(model).id ?? record(model).model)
      if (id !== undefined) allowed.add(id)
    }
  }
  return allowed.size === 0 ? undefined : allowed
}

/** Reasoning tiers the product document may declare for a route. */
export const WORKBUDDY_REASONING_TIERS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** One tier id the document can name. */
export type WorkBuddyReasoningTier = (typeof WORKBUDDY_REASONING_TIERS)[number]

/**
 * The ladder offered for a route whose declaration carries no tier list.
 *
 * Measured against the live international gateway: a route that states only a
 * single `effort` (the free `deepseek-v4.1-flash` states `high`) accepts every
 * one of these and behaves according to it, while sending no effort at all
 * stops it reasoning.
 */
const WORKBUDDY_REASONING_LADDER: readonly WorkBuddyReasoningTier[] = WORKBUDDY_REASONING_TIERS

/** Read one declared tier id, rejecting anything the product does not name. */
function declaredTier(value: unknown): WorkBuddyReasoningTier | undefined {
  const text = string(value)?.toLowerCase()
  return WORKBUDDY_REASONING_TIERS.find(tier => tier === text)
}

/**
 * Read one row's reasoning declaration out of the product document.
 *
 * The document is the only honest source for this: it states whether the route
 * reasons at all (`supportsReasoning`/`onlyReasoning`), whether thinking can be
 * turned off (`canDisableThinking`), which tiers it accepts
 * (`supportedEfforts`) and the product's own default (`defaultEffort`, or the
 * older single `effort` field). The plugin used to hardcode one ladder of
 * off/low/medium/high for every route, which is why a chosen level looked
 * inert: for `hy3` and `hy4-preview` the upstream ignores "Off" entirely
 * (`canDisableThinking: false`) and for `glm-5.3` the tier the product actually
 * declares — `max` — was not even offered.
 * @param row - one route row from the product document.
 * @returns the reasoning declaration, or `undefined` when the route declares none.
 */
export function parseWorkBuddyReasoning(row: Record<string, unknown>): WorkBuddyInternationalModel['reasoning'] | undefined {
  const raw = record(row.reasoning)
  if (row.supportsReasoning !== true && Object.keys(raw).length === 0) return undefined
  const supported: WorkBuddyReasoningTier[] = []
  for (const value of Array.isArray(raw.supportedEfforts) ? raw.supportedEfforts : []) {
    const tier = declaredTier(value)
    if (tier !== undefined && !supported.includes(tier)) supported.push(tier)
  }
  const defaultEffort = declaredTier(raw.defaultEffort) ?? declaredTier(raw.effort)
  return {
    supports: true,
    onlyReasoning: row.onlyReasoning === true,
    ...(supported.length === 0 ? {} : { supportedEfforts: supported }),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    // An explicit `false` is the document saying thinking cannot be switched
    // off; a route that omits the flag is switchable (measured on the free
    // `deepseek-v4.1-flash`: omitting the effort stops its reasoning).
    canDisableThinking: raw.canDisableThinking === false ? false : true,
  }
}

/**
 * The exact efforts to offer for one route, and the one to preselect.
 *
 * `undefined` means the route has no reasoning control to show. `off` is only
 * offered when the product says thinking can be disabled, so the menu never
 * advertises a level the upstream ignores.
 * @param model - the route whose declaration is read.
 * @returns the efforts to offer and the default, or `undefined` when there is no control.
 */
export function workBuddyReasoningOptions(
  model: WorkBuddyInternationalModel | undefined,
): { readonly efforts: readonly WorkBuddyReasoningTier[]; readonly canDisable: boolean; readonly defaultEffort: string } | undefined {
  const declared = model?.reasoning
  if (declared === undefined || ! declared.supports) return undefined
  const efforts = declared.supportedEfforts ?? WORKBUDDY_REASONING_LADDER
  const canDisable =  declared.canDisableThinking
  // A route that cannot stop thinking has no "off" to preselect, so the
  // document's own tier is the default; otherwise the default is the product's
  // when it states one, and off only when it states nothing.
  const defaultEffort = canDisable
    ? declared.defaultEffort ?? 'off'
    : declared.defaultEffort ?? efforts[0] ?? 'high'
  return { efforts, canDisable, defaultEffort }
}

/** Human-readable name for one declared tier. */
function workBuddyEffortLabel(tier: WorkBuddyReasoningTier): string {
  return tier === 'xhigh' ? 'X-High' : tier.charAt(0).toUpperCase() + tier.slice(1)
}

/**
 * Parse the product document into routes.
 *
 * Tolerant on purpose — the document is the App's private config, not a
 * documented API: rows without a usable id are dropped, the allowlist is
 * honoured when present, and a bad multiplier degrades to "not free" rather than
 * to a number nobody stated.
 * @param payload - the payload to interpret, of unknown shape.
 * @returns the work Buddy Intl Route rows, in backend order.
 */
export function parseWorkBuddyCatalog(payload: unknown): readonly WorkBuddyIntlRoute[] {
  const envelope = record(payload)
  const data = Object.keys(record(envelope.data)).length > 0 ? record(envelope.data) : envelope
  const rows = Array.isArray(data.models) ? data.models.map(record) : []
  const allowed = allowedRoutes(data)
  const promotionRows = data.modelPromotions
  const routes: WorkBuddyIntlRoute[] = []
  for (const row of rows) {
    const id = string(row.id ?? row.modelId ?? row.model)
    if (id === undefined || row.disabled === true) continue
    if (allowed !== undefined && !allowed.has(id)) continue
    const credits = string(row.credits)
    const multiplier = rateMultiplierOf(credits, number(row.rateMultiplier))
    const free = multiplier === 0 || /^x?0\.0+$/u.test(credits ?? '')
    const badges = Array.isArray(row.tags)
      ? row.tags.map(tag => string(tag)).filter((tag): tag is string => tag !== undefined).map(tag => tag.replace(/^badge:/iu, '').split(':')[0] ?? tag)
      : []
    const contextWindow = number(row.maxInputTokens) ?? number(record(row.contextWindow).defaultLength) ?? number(row.contextWindow)
    const maxTokens = number(row.maxOutputTokens)
    const promotions = promotionsFor(promotionRows, id)
    const reasoning = parseWorkBuddyReasoning(row)
    routes.push({
      id,
      displayName: string(row.name ?? row.displayName) ?? id,
      provider: 'workbuddy',
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      supportsImages: row.supportsImages === true && row.disabledMultimodal !== true,
      rateMultiplier: free ? 0 : multiplier ?? 1,
      ...(reasoning === undefined ? {} : { reasoning }),
      billing: {
        ...(credits === undefined ? {} : { credits }),
        ...(badges.length === 0 ? {} : { badges }),
        free,
      },
      ...(promotions === undefined ? {} : { promotions }),
    })
  }
  return routes
}

/**
 * The free routes the pool can serve right now, live-only with a documented
 * seed.
 *
 * Promotions are re-evaluated here rather than trusted from the parse: the
 * directory is cached for minutes, and a discount that expired inside that
 * window must leave the list on its own. The returned rows are marked free, so
 * the card can never receive a row whose own billing disagrees with the list it
 * arrived in.
 * @returns the work Buddy International Model rows, in backend order.
 * @param routes - the parsed directory routes.
 * @param now - the time the promotions are re-evaluated at.
 */
export function freeRoutesOf(routes: readonly WorkBuddyIntlRoute[], now = Date.now()): readonly WorkBuddyInternationalModel[] {
  const free = routes.filter(route => isFreeRoute(route, now))
  if (free.length === 0) return [WORKBUDDY_INTL_FALLBACK_ROUTE]
  return free.map(route => route.billing?.free === true ? route : { ...route, billing: { ...route.billing, free: true } })
}

/**
 * One route's price as the picker and the settings checklist read it.
 *
 * The `×N` marker is not decoration: it is the only price channel a browser half
 * has, and `model-price.ts` reads it to decide whether a row starts shown. A
 * metered route that arrived without one would look exactly like a free route
 * and would be switched on by default — which is the opposite of what a priced
 * route should do.
 *
 * The multiplier is recomputed here rather than taken from the parse, for the
 * same reason {@link isFreeRoute} is: the directory is cached for minutes, and a
 * promotion that expired inside that window must stop presenting its route as
 * the cheaper one.
 * @param route - the parsed route.
 * @param now - the time the promotions are re-evaluated at.
 * @returns the description string.
 */
export function workBuddyModelDescription(route: WorkBuddyIntlRoute, now = Date.now()): string {
  const free = isFreeRoute(route, now)
  const multiplier = free ? 0 : route.rateMultiplier ?? 1
  return `WorkBuddy · ×${multiplier} · ${free ? 'free' : 'metered'}`
}

/**
 * Apply the international endpoint's preconditions to a serialized body.
 *
 * `developer` is rejected outright (the CN twin of that code means something
 * else, so the rewrite is spelling-based, not code-based), and a body whose
 * first message is not `system` is refused with HTTP 400 code 11128. The
 * prepended line contains no user content, and existing messages keep their
 * order: this only satisfies the gateway, it never steers the model.
 *
 * `prompt_cache_key` is the exception that is not a precondition but a price:
 * the backend enables prefix caching only when the key is present, and a turn of
 * the same conversation repeated without it reports `prompt_cache_hit_tokens: 0`
 * at several times the cost of the identical turn sent with it. A caller that
 * already stated a key keeps it.
 * @param body - the serialized chat body.
 * @param cacheKey - the conversation's prefix-cache key, normally the session id.
 * @returns the body with the international endpoint's preconditions applied.
 */
export function prepareWorkBuddyChatBody(body: Record<string, unknown>, cacheKey?: string): Record<string, unknown> {
  const source = Array.isArray(body.messages) ? body.messages : []
  const messages = source.map((message) => {
    const row = record(message)
    return row.role === 'developer' ? { ...row, role: 'system' } : row
  })
  if (record(messages[0]).role !== 'system') messages.unshift({ role: 'system', content: WORKBUDDY_SYSTEM_PREAMBLE })
  return {
    ...body,
    messages,
    stream: true,
    ...(cacheKey === undefined || body.prompt_cache_key !== undefined ? {} : { prompt_cache_key: cacheKey }),
  }
}

/**
 * What one chat turn declares about itself.
 *
 * The desktop client sends a session identity on every turn as both
 * `X-Conversation-ID` and the prefix-cache key, so the two are one value here:
 * a turn whose cache key changed per request would warm a fresh prefix every
 * time and pay full price for a conversation that is otherwise identical.
 */
export interface WorkBuddyChatConversation {
  /** The conversation this turn belongs to; a turn without one starts a new conversation. */
  readonly sessionId?: string
}

/** One credential pair a finished browser authorization issued. */
export interface WorkBuddyLoginTicket {
  readonly accessToken: string
  readonly refreshToken?: string
  /** Epoch ms; a payload that stated no usable expiry gets a one-hour window. */
  readonly expiresAt: number
  readonly uid?: string
  readonly domain?: string
  readonly enterpriseId?: string
  readonly nickname?: string
  readonly email?: string
}

/** The outcome of one poll against the plugin-token endpoint. */
export type WorkBuddyLoginPollResult =
  | { readonly kind: 'pending' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'granted'; readonly ticket: WorkBuddyLoginTicket }

/**
 * Read one answer from the browser-authorization poll endpoint.
 *
 * The endpoint is a single URL with three meanings: business code 11217 means
 * the user has not finished signing in, any other non-zero code is a refusal,
 * and a payload carrying an access token is the credential pair. The token
 * lives at `data` on the observed shape, but the same endpoint has been seen to
 * nest the pair under `auth` with the identity under `account`, so all three
 * spellings are read rather than making a signed-in user wait on a guess.
 * @param payload - the payload to interpret, of unknown shape.
 * @returns the work Buddy Login Poll Result.
 */
export function parseWorkBuddyLoginPoll(payload: unknown): WorkBuddyLoginPollResult {
  const envelope = record(payload)
  const data = record(envelope.data)
  const auth = Object.keys(record(data.auth)).length > 0 ? record(data.auth) : data
  const identity = Object.keys(record(data.account)).length > 0 ? record(data.account) : auth
  const accessToken = string(auth.accessToken) ?? string(auth.access_token) ?? string(auth.token)
  const code = number(envelope.code)
  if (accessToken === undefined) {
    if (code === WORKBUDDY_LOGIN_PENDING_CODE) return { kind: 'pending' }
    if (code !== undefined && code !== 0) return { kind: 'failed', message: redact(string(envelope.msg) ?? `code ${code}`) }
    // A code-0 answer with no token is the sign-in still settling; the caller's
    // own deadline decides when waiting is over.
    return { kind: 'pending' }
  }
  const refreshToken = string(auth.refreshToken) ?? string(auth.refresh_token)
  const uid = string(identity.uid ?? data.uid)
  const domain = string(identity.domain ?? data.domain)
  const enterpriseId = string(identity.enterpriseId ?? data.enterpriseId)
  const nickname = string(identity.nickname ?? data.nickname)
  const email = string(identity.email ?? data.email)
  return {
    kind: 'granted',
    ticket: {
      accessToken,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      expiresAt: parseExpiry(auth.expiresAt ?? auth.expires_at)
        ?? ((number(auth.expiresIn) ?? 0) > 0 ? Date.now() + number(auth.expiresIn)! * 1_000 : Date.now() + 3_600_000),
      ...(uid === undefined ? {} : { uid }),
      ...(domain === undefined ? {} : { domain }),
      ...(enterpriseId === undefined ? {} : { enterpriseId }),
      ...(nickname === undefined ? {} : { nickname }),
      ...(email === undefined ? {} : { email }),
    },
  }
}

/** A server-issued device-authorization grant: the poll key and the URL to open. */
export interface WorkBuddyDeviceAuthorization {
  readonly state: string
  readonly authUrl: string
}

/**
 * Read the grant from `POST /v2/plugin/auth/state` (`{code,msg,data:{state,authUrl}}`).
 *
 * Both halves are required: the `state` is the poll key and the `authUrl` is the
 * only link whose sign-in result is recorded under it. Returning `undefined`
 * lets the caller fail loudly rather than open an unbound login page, which is
 * exactly how the old client-generated state dead-ended.
 * @param payload - the payload to interpret, of unknown shape.
 * @returns the state and auth URL, or `undefined` when the payload is unusable.
 */
export function parseWorkBuddyAuthState(payload: unknown): WorkBuddyDeviceAuthorization | undefined {
  const data = record(record(payload).data)
  const state = string(data.state) ?? string(record(payload).state)
  const authUrl = string(data.authUrl) ?? string(data.authURL) ?? string(data.url)
  // The URL is handed to the system browser *and* rendered as a clickable link
  // in Settings, so it has to clear the same allow-list the opener applies: a
  // `javascript:`/`file:` value from a hostile or compromised gateway would
  // otherwise be one click away from running in the Settings origin. Rejecting
  // it fails the sign-in instead, which is the only honest outcome — there is
  // no page to open.
  if (state === undefined || authUrl === undefined || !isHttpUrl(authUrl)) return undefined
  return { state, authUrl }
}

/** One authenticated identity read for a state that just issued tokens. 
 * @param payload - the payload to interpret, of unknown shape.
 * @returns the identity fields the payload carries, each absent when unstated.
 */
export function parseWorkBuddyLoginAccount(payload: unknown): { uid?: string; nickname?: string; enterpriseId?: string; email?: string } {
  const data = record(record(payload).data)
  const identity = Object.keys(record(data.account)).length > 0 ? record(data.account) : data
  const uid = string(identity.uid) ?? string(data.uid)
  const nickname = string(identity.nickname) ?? string(data.nickname)
  const enterpriseId = string(identity.enterpriseId) ?? string(data.enterpriseId)
  const email = string(identity.email) ?? string(data.email)
  return {
    ...(uid === undefined ? {} : { uid }),
    ...(nickname === undefined ? {} : { nickname }),
    ...(enterpriseId === undefined ? {} : { enterpriseId }),
    ...(email === undefined ? {} : { email }),
  }
}

/** The waiting time an upstream answer asks for, when it states one. */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after')
  if (header !== null) {
    const seconds = Number(header.trim())
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1_000
  }
  return undefined
}

/** The `data:` payload of an upstream SSE turn, when the failure carried one. */
function cooldownFromBody(detail: string): number | undefined {
  const minutes = /(\d+)\s*m(?!s)/iu.exec(detail)
  const seconds = /(\d+)\s*s/iu.exec(detail)
  const total = (minutes === null ? 0 : Number(minutes[1]) * 60_000) + (seconds === null ? 0 : Number(seconds[1]) * 1_000)
  return total > 0 ? total : undefined
}

/** Read a credit amount that may arrive as a number or a numeric string. */
function credit(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** The first present key's numeric value, walking nested objects. */
function firstCredit(sources: readonly Record<string, unknown>[], keys: readonly string[]): number | undefined {
  for (const source of sources) {
    for (const key of keys) {
      const value = credit(source[key])
      if (value !== undefined) return value
    }
  }
  return undefined
}

/** Descend one dotted path, returning `undefined` on any missing hop. */
function atPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/**
 * The array a credit response carries, under any of its observed spellings.
 *
 * The product's page reads `data.Accounts`; older gateway configs wrapped the
 * same rows one and two levels deeper, and the summary endpoint names them
 * `Packages`. Every spelling is probed rather than guessing one. */
function creditRows(payload: unknown, kind: 'accounts' | 'packages'): readonly unknown[] | undefined {
  const names = kind === 'accounts' ? ['Accounts', 'accounts'] : ['Packages', 'packages']
  for (const name of names) {
    const candidates = [
      ['data', name],
      ['data', 'data', name],
      ['data', 'Response', 'Data', name],
      ['data', 'data', 'Response', 'Data', name],
    ] as const
    for (const path of candidates) {
      const rows = atPath(payload, path)
      if (Array.isArray(rows)) return rows
    }
  }
  return undefined
}

/** Read an expiry written as epoch seconds, epoch ms, ISO, or `YYYY-MM-DD`. */
function creditExpiry(value: unknown): number | undefined {
  const numeric = credit(value)
  if (numeric !== undefined && numeric > 0) return numeric < 1e11 ? numeric * 1_000 : numeric
  const text = string(value)
  if (text === undefined) return undefined
  const parsed = Date.parse(text.includes('T') || /Z$|[+-]\d\d:?\d\d$/u.test(text) ? text : text.replace(' ', 'T'))
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Normalize one credit row into the package shape this provider reports.
 *
 * Sources disagree on field names and on whether the empty-string spelling is
 * used for an unknown number, so the parser reads a candidate list per concept
 * and never invents a figure: an unreadable amount becomes `0`, which is what
 * "no credits reported" means for a total. 
 * @returns the work Buddy Credit Package.
 * @param row - one credit row of unknown shape.
 * @param now - the time relative expiries are computed from.
 */
export function parseWorkBuddyCreditPackage(row: unknown, now = Date.now()): WorkBuddyCreditPackage {
  const source = record(row)
  const slices = Array.isArray(source.SlicePeriodUsageDetails) ? source.SlicePeriodUsageDetails : Array.isArray(source.slicePeriodUsageDetails) ? source.slicePeriodUsageDetails : []
  const sources = [source, record(slices[0])]
  const total = firstCredit(sources, [
    'CycleCapacitySizePrecise', 'CycleCapacitySize', 'CycleTotalCapacity', 'CapacitySizePrecise', 'CapacitySize',
    'SlicePeriodCapacitySizePrecise', 'SlicePeriodCapacitySize',
  ])
  const remaining = firstCredit(sources, [
    'CycleCapacityRemainPrecise', 'CycleCapacityRemain', 'CycleRemainCapacity', 'CapacityRemainPrecise', 'CapacityRemain',
    'SlicePeriodCapacityRemainPrecise', 'SlicePeriodCapacityRemain',
  ])
  const used = firstCredit(sources, [
    'CycleCapacityUsedPrecise', 'CycleCapacityUsed', 'CycleUsedCapacity', 'CapacityUsedPrecise', 'CapacityUsed',
    'SlicePeriodCapacityUsedPrecise', 'SlicePeriodCapacityUsed',
  ])
  const resolvedTotal = Math.max(0, total ?? (remaining !== undefined && used !== undefined ? remaining + used : remaining ?? used ?? 0))
  const resolvedRemaining = Math.max(0, remaining ?? Math.max(0, resolvedTotal - (used ?? 0)))
  const resolvedUsed = Math.max(0, used ?? Math.max(0, resolvedTotal - resolvedRemaining))
  const expireAt = creditExpiry(source.DeductionEndTime ?? source.deductionEndTime ?? source.ExpiredTime ?? source.expiredTime ?? source.CycleEndTime ?? source.cycleEndTime)
  const packageCode = string(source.PackageCode ?? source.packageCode)
  const packageName = string(source.PackageName ?? source.packageName)
  return {
    ...(packageCode === undefined ? {} : { packageCode }),
    ...(packageName === undefined ? {} : { packageName }),
    total: resolvedTotal,
    remaining: resolvedRemaining,
    used: resolvedUsed,
    ...(expireAt === undefined ? {} : { expireAt }),
    expired: expireAt !== undefined && expireAt <= now,
    expiringSoon: expireAt !== undefined && expireAt > now && expireAt - now <= WORKBUDDY_CREDIT_EXPIRING_SOON_MS,
  }
}

/** `YYYY-MM-DD HH:mm:ss` in local time, the form these endpoints filter on. */
function timestampText(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => value.toString().padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * The query the product's plan page sends for one package class.
 *
 * The filter codes come from the public plan configuration; the parser never
 * depends on them, so a package the list does not name still arrives through
 * the summary query.
 */
function creditPackagesQuery(kind: 'paid' | 'free', now: number): Record<string, unknown> {
  if (kind === 'paid') {
    return { PageNumber: 1, PageSize: 200, Status: [0, 3], PackageCodes: WORKBUDDY_INTL_PAID_PACKAGE_CODES, NeedRenewInfo: true }
  }
  // The free class is sliced to today: that endpoint returns the day's grants.
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const end = new Date(now)
  end.setHours(23, 59, 59, 0)
  return {
    PageNumber: 1,
    PageSize: 200,
    Status: [0, 3],
    SlicePeriodStartTime: timestampText(start.getTime()),
    SlicePeriodEndTime: timestampText(end.getTime()),
    PackageCodes: WORKBUDDY_INTL_FREE_PACKAGE_CODES,
  }
}

/**
 * Fold the summary rows into the detail rows, detail winning per package.
 *
 * Both endpoints describe the same packages: the detail rows carry the real
 * remaining amount and expiry, the summary row repeats the same package with a
 * coarser figure. A summary row for a package already described in detail is a
 * duplicate, never an extra package.
 */
function mergeCreditPackages(detail: readonly WorkBuddyCreditPackage[], summary: readonly WorkBuddyCreditPackage[]): readonly WorkBuddyCreditPackage[] {
  const described = new Set(detail.map(entry => entry.packageCode).filter((code): code is string => code !== undefined))
  return [...detail, ...summary.filter(entry => entry.packageCode === undefined || !described.has(entry.packageCode))]
}

/** The upstream's own reason a credit response was refused. 
 * @param payload - the payload to interpret, of unknown shape.
 * @returns the refusal reason, or `undefined` when the envelope reports success.
 */
export function workBuddyEnvelopeError(payload: unknown): string | undefined {
  const envelope = record(payload)
  const nested = record(envelope.data)
  for (const candidate of [envelope.msg, envelope.message, nested.msg, nested.message]) {
    const text = string(candidate)
    if (text !== undefined) return text.slice(0, 160)
  }
  const code = number(envelope.code) ?? number(nested.code)
  return code === undefined || code === 0 || code === 200 ? undefined : `code=${code}`
}

/** Whether an envelope reports success (no code, `0`, or `200`). 
 * @param payload - the payload to interpret, of unknown shape.
 * @returns whether the envelope reports success.
 */
export function workBuddyEnvelopeOk(payload: unknown): boolean {
  const envelope = record(payload)
  if (Object.keys(envelope).length === 0) return false
  const code = number(envelope.code) ?? number(record(envelope.data).code)
  if (code !== undefined) return code === 0 || code === 200
  // A body with no code at all is judged by what it carries: a `data` object
  // means the gateway answered, an `ok: false`/`success: false` means it did not.
  return envelope.ok !== false && envelope.success !== false && ('data' in envelope || 'ok' in envelope || 'success' in envelope)
}

/**
 * Whether a failed response is an expired/rejected credential.
 *
 * The HTTP status is read through the shared table, so `401` is the only one that
 * answers yes: a `403` is the plan gate on *this route* — the reading the error code
 * uses too — and refreshing a token cannot make a plan accept a model. Answering yes
 * for `403` burned a rotation on every gate, which is the mistake this file already
 * names for code `10085` (*"refreshing cannot fix it and would burn a rotation"*),
 * and replayed a request the upstream had refused on other grounds.
 *
 * The envelope's own `code` is read separately, because it is the gateway's
 * numbering and not an HTTP status: a `401`/`403` there is this upstream's spelling
 * of a credential refusal, and that reading is unchanged.
 */
function workBuddyUnauthorized(status: number, payload: unknown): boolean {
  if (upstreamStatusCategory(status) === 'auth') return true
  // Gateways answer 200 with the refusal in the body, so the body is read too.
  const envelope = record(payload)
  const code = number(envelope.code) ?? number(record(envelope.data).code)
  if (code === 401 || code === 403) return true
  // WAF/client-fingerprint refusal (10085) is not a token problem: refreshing
  // cannot fix it and would burn a rotation.
  if (code === 10_085) return false
  const message = (workBuddyEnvelopeError(payload) ?? '').toLowerCase()
  if (message.includes('unauthorized') || message.includes('401')) return true
  // Credential trouble is stated about the credential, and the two halves are
  // required together: a business refusal that merely mentions 过期 is not a
  // token problem, and treating it as one burned a token rotation on every
  // refusal that happened to use that word.
  const aboutCredential = /token|凭证|凭据|登录/.test(message)
  const expired = /invalid|expired|revoked|失效|过期|无效|未授权|重新登录/.test(message)
  return aboutCredential && expired
}

/** Aggregate packages into the account-level credit position. 
 * @returns the work Buddy Credits.
 * @param packages - the parsed credit packages to aggregate.
 * @param checkedAt - the time this snapshot was taken.
 * @param error - the failure to attach, when the sweep could not answer.
 */
export function summarizeWorkBuddyCredits(packages: readonly WorkBuddyCreditPackage[], checkedAt: number, error?: string): WorkBuddyCredits {
  let total = 0
  let remaining = 0
  let used = 0
  let soonest: number | undefined
  let expiringSoon = false
  let expired = false
  for (const entry of packages) {
    total += entry.total
    remaining += entry.remaining
    used += entry.used
    if (entry.remaining <= 0) continue
    if (entry.expireAt !== undefined && (soonest === undefined || entry.expireAt < soonest)) soonest = entry.expireAt
    if (entry.expiringSoon) expiringSoon = true
    if (entry.expired) expired = true
  }
  return {
    total: Math.round(total * 100) / 100,
    remaining: Math.round(remaining * 100) / 100,
    used: Math.round(used * 100) / 100,
    ...(soonest === undefined ? {} : { soonestExpireAt: soonest }),
    expiringSoon,
    expired,
    packages,
    checkedAt,
    ...(error === undefined ? {} : { error }),
  }
}

/**
 * A WorkBuddy International client over the stored account pool.
 */
export class WorkBuddyIntlClient {
  private cursor = 0
  private readonly cooldowns = new Map<string, number>()
  /** One in-flight token exchange per account; see {@link refresh}. */
  private readonly exchanges = new Map<string, Promise<WorkBuddyInternationalAccount>>()
  private catalogCache: { readonly expiresAt: number; readonly routes: readonly WorkBuddyIntlRoute[] } | undefined
  private catalogPromise: Promise<readonly WorkBuddyIntlRoute[]> | undefined

  /**
   * @param credentials - Host vault holding the account pool; `undefined` before
   *   the credential service mounts, which reads as "signed out".
   * @param persistTokens - Optional writer for a rotated token pair. Without it a
   *   refresh stays in memory, and an upstream that rotates refresh tokens would
   *   invalidate the stored one on the next restart.
   */
  constructor(
    private readonly credentials: CredentialProvider | undefined,
    private readonly persistTokens?: (account: WorkBuddyInternationalAccount) => Promise<void>,
  ) {}

  /** The pool, newest first is not guaranteed: the order is the vault's. 
   * @returns the work Buddy International Account rows, in backend order.
   */
  async accounts(): Promise<readonly WorkBuddyInternationalAccount[]> {
    return readWorkBuddyIntlAccounts(this.credentials)
  }

/**
 * Whether the pool holds at least one account.
 * @returns whether any account is available.
 */
  async signedIn(): Promise<boolean> {
    return (await this.accounts()).length > 0
  }

  /**
   * One authenticated JSON POST carrying this pool's identity headers.
   *
   * Credit and check-in calls share this shape: not streaming, answering a JSON
   * envelope, and reporting an expired token inside the body as often as with a
   * 401. `x-client-platform: web` is the header the product's own plans-usage
   * page always sends, and the gateway treats its absence as an unknown client
   * on some routes.
   */
  private async sendJson(credential: WorkBuddyInternationalAccount, url: string, body: unknown): Promise<{ readonly status: number; readonly payload: unknown }> {
    const response = await fetch(url, {
      method: 'POST',
      headers: this.surfaceHeaders('credits', credential),
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(WORKBUDDY_INTL_BILLING_TIMEOUT_MS),
    })
    return { status: response.status, payload: await response.json().catch(() => ({})) }
  }

  /** One JSON POST that refreshes the token once when the upstream rejects it. */
  private async authorizedJson(account: WorkBuddyInternationalAccount, url: string, body: unknown): Promise<{ readonly status: number; readonly payload: unknown; readonly account: WorkBuddyInternationalAccount }> {
    const credential = await this.accessToken(account)
    const first = await this.sendJson(credential, url, body)
    if (!workBuddyUnauthorized(first.status, first.payload)) return { ...first, account: credential }
    const refreshed = await this.refresh(credential)
    const second = await this.sendJson(refreshed, url, body)
    return { ...second, account: refreshed }
  }

  /**
   * The account's remaining credits, split into its resource packages.
   *
   * Three questions are asked in parallel because that is how the product's own
   * page reads them, and because a package can only appear on one of them. They
   * share one credential deliberately: three independent refreshes would race to
   * write back different rotated tokens. If any branch is rejected, the token is
   * refreshed exactly once and only the rejected branches are replayed.
   *
   * The legacy aggregate query is the fallback, reached only when none of the
   * three answered in a shape this provider understands.
 * @param account - the account to query first.
 * @returns the aggregated credits and the account the failing call ended on.
   */
  async credits(account: WorkBuddyInternationalAccount): Promise<{ readonly credits: WorkBuddyCredits; readonly account: WorkBuddyInternationalAccount }> {
    const now = Date.now()
    const requests = [
      { url: WORKBUDDY_INTL_RESOURCE_SUMMARY_URL, body: {} as Record<string, unknown>, kind: 'packages' as const },
      { url: WORKBUDDY_INTL_RESOURCE_PAID_URL, body: creditPackagesQuery('paid', now), kind: 'accounts' as const },
      { url: WORKBUDDY_INTL_RESOURCE_FREE_URL, body: creditPackagesQuery('free', now), kind: 'accounts' as const },
    ]
    let credential = await this.accessToken(account)
    let results = await Promise.all(requests.map(request => this.sendJson(credential, request.url, request.body)))
    if (results.some(result => workBuddyUnauthorized(result.status, result.payload))) {
      credential = await this.refresh(credential)
      results = await Promise.all(results.map((result, index) => workBuddyUnauthorized(result.status, result.payload)
        ? this.sendJson(credential, requests[index]!.url, requests[index]!.body)
        : Promise.resolve(result)))
    }
    const detail: WorkBuddyCreditPackage[] = []
    const summary: WorkBuddyCreditPackage[] = []
    const failures: string[] = []
    let answered = false
    for (let index = 0; index < requests.length; index++) {
      const request = requests[index]!
      const result = results[index]!
      const reason = workBuddyEnvelopeOk(result.payload) ? undefined : workBuddyEnvelopeError(result.payload) ?? `HTTP ${result.status}`
      const rows = reason === undefined ? creditRows(result.payload, request.kind) : undefined
      if (rows === undefined) {
        failures.push(reason ?? 'unrecognised credit response')
        continue
      }
      // An empty array is still an answer: the account simply holds none of
      // that resource class, which must not trigger the legacy fallback.
      answered = true
      const target = request.kind === 'packages' ? summary : detail
      for (const row of rows) target.push(parseWorkBuddyCreditPackage(row, now))
    }
    if (answered) return { credits: summarizeWorkBuddyCredits(mergeCreditPackages(detail, summary), now), account: credential }
    const legacy = await this.authorizedJson(credential, WORKBUDDY_INTL_BILLING_URL, {
      PageNumber: 1,
      PageSize: 100,
      ProductCode: WORKBUDDY_INTL_PRODUCT_CODE,
      Status: [0, 3],
      PackageEndTimeRangeBegin: timestampText(now),
      PackageEndTimeRangeEnd: timestampText(now + 365 * 101 * 24 * 3_600_000),
    })
    const rows = creditRows(legacy.payload, 'accounts')
    if (rows !== undefined && workBuddyEnvelopeOk(legacy.payload)) {
      return { credits: summarizeWorkBuddyCredits(mergeCreditPackages(rows.map(row => parseWorkBuddyCreditPackage(row, now)), []), now), account: legacy.account }
    }
    return {
      credits: summarizeWorkBuddyCredits([], now, workBuddyEnvelopeError(legacy.payload) ?? failures[0] ?? 'credit query failed'),
      account: legacy.account,
    }
  }

  /** Drop the cached route directory so the next read hits the network. */
  invalidateCatalog(): void {
    this.catalogCache = undefined
    this.catalogPromise = undefined
  }

  /**
   * The free routes available to this pool, read from the live document.
   *
   * A signed-out pool has no directory at all rather than a seeded one: the seed
   * exists for a reachable account whose document is not readable yet, not for
   * advertising WorkBuddy to someone who never signed in.
   * @returns the work Buddy International Model rows, in backend order.
   */
  async freeModels(): Promise<readonly WorkBuddyInternationalModel[]> {
    if (!(await this.signedIn())) return []
    return freeRoutesOf(await this.catalog())
  }

  /**
   * Every route the product document declares, free or metered.
   *
   * {@link freeModels} answers "what can this pool serve for nothing"; this
   * answers "what does the pool hold", which is what the settings checklist has
   * to show so a user can switch a metered route on deliberately. The account
   * has to be signed in for either: an unsigned pool can still be *asked* to
   * route a paid model, and offering one before a credential exists would be an
   * offer nobody can accept.
   * @returns the parsed routes, in product order; empty when signed out.
   */
  async allModels(): Promise<readonly WorkBuddyIntlRoute[]> {
    if (!(await this.signedIn())) return []
    return await this.catalog()
  }

  /** Stream one chat completion, rotating accounts on auth and credit failures. 
   * @param body - the chat-completions body to stream.
   * @param signal - aborts the request when the caller cancels.
   * @param conversation - the conversation identity this turn belongs to; absent means the turn starts one.
   * @returns the response.
   */
  async chat(body: Record<string, unknown>, signal?: AbortSignal, conversation?: WorkBuddyChatConversation): Promise<Response> {
    const selected = await readWorkBuddyIntlActiveId(this.credentials)
    const pool = await this.accounts()
    if (pool.length === 0) throw new Error('WORKBUDDY_LOGIN_REQUIRED: sign in to WorkBuddy International first')
    const now = Date.now()
    // A chosen account starts the scan; without one the cursor keeps spreading
    // turns across the pool. Either way the scan walks the whole pool, because a
    // spent or rate-limited account must not fail the turn.
    const ordered = selectedFirst(pool, selected)
    const ready = ordered.filter(account => (this.cooldowns.get(account.id) ?? 0) <= now)
    // Every parked account is not a reason to fail: the cooldown is a hint, so
    // the pool is still tried once before the turn gives up.
    const candidates = ready.length > 0 ? ready : ordered
    const start = selected === undefined ? this.cursor : 0
    // One conversation identity for the whole turn, so every retry in the walk
    // below is the same conversation to the gateway — which is also what lets a
    // retried request reuse the prefix cache the first one warmed.
    const conversationId = conversation?.sessionId ?? randomUUID()
    const model = string(body.model) ?? ''
    const payload = JSON.stringify(prepareWorkBuddyChatBody(body, conversationId))
    let lastStatus = 0
    let lastDetail = ''
    for (let index = 0; index < candidates.length; index++) {
      const account = candidates[(start + index) % candidates.length]
      if (account === undefined) continue
      let credential: WorkBuddyInternationalAccount
      try {
        credential = await this.accessToken(account)
      } catch (error) {
        lastStatus = lastStatus === 0 ? 401 : lastStatus
        lastDetail = lastDetail === '' ? failureDetail(error) : lastDetail
        continue
      }
      let response = await this.send(credential, payload, model, conversationId, signal)
      if (response.status === 401) {
        // A stale token and a dead account look identical from here; one forced
        // refresh decides which one this is.
        await response.text().catch(() => '')
        try {
          credential = await this.refresh(credential)
        } catch (error) {
          this.cooldowns.set(account.id, Date.now() + WORKBUDDY_INTL_COOLDOWN_BY_CATEGORY.auth)
          lastStatus = 401
          lastDetail = failureDetail(error)
          continue
        }
        response = await this.send(credential, payload, model, conversationId, signal)
      }
      if (response.ok) {
        this.cooldowns.delete(account.id)
        // The cursor is left alone while a selection is in force: it would
        // otherwise be advanced past a start that is no longer the cursor's.
        if (selected === undefined) this.cursor = (this.cursor + index + 1) % candidates.length
        return response
      }
      lastStatus = response.status
      lastDetail = await this.fail(account, response)
    }
    throw new WorkBuddyIntlError(lastStatus === 0 ? 502 : lastStatus, lastDetail)
  }

  /**
   * Park an account that could not serve this turn and return the redacted
   * reason.
   *
   * The upstream's own delay always wins when it states one — a `Retry-After`, or a
   * wait carried in the envelope — because that is a measurement where the table
   * below is a policy. Credit exhaustion is an account-level fact, so it parks the
   * account for longer than a rate hint; both walk the pool instead of failing the
   * turn.
   */
  private async fail(account: WorkBuddyInternationalAccount, response: Response): Promise<string> {
    const raw = await response.text().catch(() => '')
    const detail = redact(raw)
    const wait = retryAfterMs(response) ?? cooldownFromBody(raw)
      ?? WORKBUDDY_INTL_COOLDOWN_BY_CATEGORY[upstreamStatusCategory(response.status)]
    this.cooldowns.set(account.id, Date.now() + wait)
    return detail
  }

  private async send(account: WorkBuddyInternationalAccount, payload: string, model: string, conversationId: string, signal?: AbortSignal): Promise<Response> {
    return fetch(WORKBUDDY_INTL_CHAT_URL, {
      method: 'POST',
      headers: this.surfaceHeaders('chat', account, { model, conversationId }),
      body: payload,
      signal: signal ?? AbortSignal.timeout(WORKBUDDY_INTL_CHAT_TIMEOUT_MS),
    })
  }

  /**
   * The complete header set one request carries, per surface.
   *
   * Read from {@link WORKBUDDY_SURFACES} instead of written per caller. What is
   * shared is shared here — the account's uid and enterprise pair, the
   * destination host, the `X-No-*` spelling of a field the import never captured
   * (sending one empty is rejected, so it is declared missing instead of
   * guessed) — and what differs is the surface's own declaration. The result is
   * checked before it leaves, so a surface that loses a header fails loudly here
   * rather than silently at the gateway.
   * @param surface - which request this is.
   * @param account - the account the request is sent as.
   * @param extras - the values only a chat turn has: its route and its conversation.
   * @returns the header map for the request.
   * @throws {Error} when the surface's declared identity is incomplete.
   */
  private surfaceHeaders(
    surface: WorkBuddyRequestSurface,
    account: WorkBuddyInternationalAccount,
    extras: { readonly model?: string; readonly conversationId?: string } = {},
  ): Record<string, string> {
    const identity = WORKBUDDY_SURFACES[surface]
    const uid = string(account.uid)
    const enterpriseId = string(account.enterpriseId)
    // The attribution headers come first, as they did when this set was written
    // out by hand: the identity below states the product, and a layer further down
    // must not be able to restate it.
    const headers: Record<string, string> = {
      ...attributionHeaders(),
      ...surfaceIdentityHeaders(workBuddyIdentity, surface, {
        authorization: `Bearer ${account.accessToken}`,
        origin: WORKBUDDY_INTL_BASE_URL,
        referer: `${WORKBUDDY_INTL_BASE_URL}/`,
        'x-requested-with': 'XMLHttpRequest',
        ...(identity.userAgent === 'model' ? { 'user-agent': workBuddyUserAgent(extras.model ?? '') } : {}),
        // Both spellings of one enterprise identity, because the routes behind this
        // base do not agree on which one they read.
        ...(enterpriseId === undefined
          ? { 'x-no-enterprise-id': '1' }
          : { 'x-enterprise-id': enterpriseId, 'x-tenant-id': enterpriseId }),
        ...domainHeader(string(account.domain)),
        // The uid, never the address: the host routes on it, and an email in this
        // slot is an identity the account does not have.
        ...(uid === undefined ? { 'x-no-user-id': '1' } : { 'x-user-id': uid }),
        ...(surface === 'chat' ? conversationHeaders(extras.conversationId ?? randomUUID()) : {}),
      }),
    }
    assertSurfaceIdentity(workBuddyIdentity, surface, headers)
    return headers
  }

  /** A valid access token for one account, refreshing when it is near expiry. */
  private async accessToken(account: WorkBuddyInternationalAccount): Promise<WorkBuddyInternationalAccount> {
    if (account.expiresAt - WORKBUDDY_INTL_REFRESH_BUFFER_MS > Date.now()) return account
    if (string(account.refreshToken) === undefined) return account
    return this.refresh(account)
  }

  /**
   * Exchange the refresh token for a new pair and keep the pool current.
   *
   * At most one exchange per account is in flight, because this one client is
   * shared by chat, the credit sweep, and the catalog read: two requests that
   * both find a near-expired token would otherwise exchange the same refresh
   * token twice. An upstream that rotates (the shape this pool is built for)
   * refuses the second exchange, and the refusal is indistinguishable from a
   * dead account — so the chat path parks a healthy account for the auth
   * cooldown and the turn fails while a fresh token sits in memory.
   */
  private async refresh(account: WorkBuddyInternationalAccount): Promise<WorkBuddyInternationalAccount> {
    const inFlight = this.exchanges.get(account.id)
    if (inFlight !== undefined) return inFlight
    const operation = this.exchange(account)
    this.exchanges.set(account.id, operation)
    try {
      return await operation
    } finally {
      if (this.exchanges.get(account.id) === operation) this.exchanges.delete(account.id)
    }
  }

  /** The network half of {@link refresh}, called once per account at a time. */
  private async exchange(account: WorkBuddyInternationalAccount): Promise<WorkBuddyInternationalAccount> {
    const refreshToken = string(account.refreshToken)
    if (refreshToken === undefined) throw new Error('WorkBuddy refresh token is unavailable; sign in again')
    const response = await fetch(WORKBUDDY_INTL_TOKEN_REFRESH_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        origin: WORKBUDDY_INTL_BASE_URL,
        referer: `${WORKBUDDY_INTL_BASE_URL}/`,
        'user-agent': WORKBUDDY_USER_AGENT,
        'x-requested-with': 'XMLHttpRequest',
        // The refresh token travels in a header, never in the body: that is the
        // shape the official client uses and the body form is not accepted.
        'x-refresh-token': refreshToken,
        'x-auth-refresh-source': 'workbuddy',
      },
      signal: AbortSignal.timeout(WORKBUDDY_INTL_CATALOG_TIMEOUT_MS * 2),
    })
    const payload = record(await response.json().catch(() => ({})))
    const data = Object.keys(record(payload.data)).length > 0 ? record(payload.data) : payload
    const accessToken = string(data.accessToken ?? data.access_token)
    if (!response.ok || accessToken === undefined) {
      throw new WorkBuddyIntlError(response.status, redact(string(payload.msg) ?? 'token refresh returned no access token'))
    }
    const next: WorkBuddyInternationalAccount = {
      ...account,
      accessToken,
      ...(string(data.refreshToken) === undefined ? {} : { refreshToken: string(data.refreshToken)! }),
      expiresAt: Date.now() + ((number(data.expiresIn) ?? 3_600) * 1_000),
    }
    this.cooldowns.delete(account.id)
    // Best effort: a failed persist costs one extra refresh later, never the turn.
    await this.persistTokens?.(next).catch(() => undefined)
    return next
  }

  /** Read (and cache) the live route directory through the account pool. */
  private async catalog(): Promise<readonly WorkBuddyIntlRoute[]> {
    const cached = this.catalogCache
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.routes
    const inFlight = this.catalogPromise
    if (inFlight !== undefined) return inFlight
    const operation = (async (): Promise<readonly WorkBuddyIntlRoute[]> => {
      const pool = await this.accounts()
      for (const account of pool) {
        try {
          const credential = await this.accessToken(account)
          const response = await fetch(WORKBUDDY_INTL_MODELS_URL, {
            // The gateway answers the App document only to the App-shaped UA,
            // which is why the surface declares its own; chat and refresh keep
            // the CLI identity.
            headers: this.surfaceHeaders('catalog', credential),
            signal: AbortSignal.timeout(WORKBUDDY_INTL_CATALOG_TIMEOUT_MS),
          })
          if (!response.ok) continue
          const routes = parseWorkBuddyCatalog(await response.json())
          if (routes.length > 0) return routes
        } catch {
          // Try the next account, then fall back to the documented route.
        }
      }
      return [WORKBUDDY_INTL_FALLBACK_ROUTE]
    })()
    this.catalogPromise = operation
    try {
      const routes = await operation
      this.catalogCache = { expiresAt: Date.now() + WORKBUDDY_INTL_MODELS_CACHE_TTL_MS, routes }
      return routes
    } finally {
      if (this.catalogPromise === operation) this.catalogPromise = undefined
    }
  }
}

/**
 * Map WorkBuddy failures onto the shared LLM error vocabulary.
 *
 * The status policy is the shared one: `401` is the sign-in itself, while
 * `402/403/429` are credit and rate gates whose credential is still good and whose
 * code must not send the user back to sign in over a spent quota. `fail()` picks a
 * cooldown for the same statuses when it parks the account that could not serve the
 * turn.
 */
function workBuddyLlmError(error: unknown): LlmError {
  if (error instanceof WorkBuddyIntlError) {
    const code = llmCodeForUpstreamStatus(error.status)
    const detail = error.detail.trim()
    const suffix = detail === '' ? '' : `（上游：${detail}）`
    const message = error.status === 401
      ? `WorkBuddy 登录凭据已被上游拒绝，请在设置中重新登录该账号。 WorkBuddy sign-in was rejected by the upstream; sign in again in Settings.${suffix}`
      : error.status === 402
        ? `WorkBuddy 账号积分不足，已改用其他账号或稍后重试。 WorkBuddy credits are exhausted for this account; another account is tried first.${suffix}`
        : `WorkBuddy 请求失败（HTTP ${error.status}），请稍后重试或更换模型。 WorkBuddy request failed (HTTP ${error.status}); retry later or pick another model.${suffix}`
    return new LlmError(message, code, { status: error.status })
  }
  if (error instanceof Error && error.message.startsWith('WORKBUDDY_LOGIN_REQUIRED')) return new LlmError(error.message, 'AUTH', { cause: error })
  return new LlmError('WorkBuddy request failed', 'TRANSPORT', { cause: error })
}

/**
 * The WorkBuddy International provider adapter.
 *
 * It owns request serialization rather than reusing the generic
 * OpenAI-compatible adapter because the free tier routes across accounts: a 401
 * must refresh and a 402 must move to the next account *within one turn*, and a
 * generic adapter that resolves one static connection per stream cannot express
 * that.
 */
export class WorkBuddyIntlAdapter extends LlmAdapter {
  constructor(private readonly client: WorkBuddyIntlClient) { super() }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'WorkBuddy' }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const signedIn = await this.client.signedIn()
    // A signed-out pool still gets a row. `freeModels()` answers "what can this
    // pool serve" and is empty without a credential, but the picker builds its
    // groups from what this method returns: an empty list hid WorkBuddy from
    // the model selector entirely, so nobody could see what signing in adds.
    // The documented route is advertised instead, marked unavailable below.
    // The whole directory, not only its free tier. A metered route is a route
    // the user may deliberately pay for, and the checklist that lists it is the
    // only place they can say so — a directory that hid it could never be
    // switched on. The row's own price decides whether it starts in the picker
    // (see `model-price.ts`), so listing it here is not the same as offering it.
    const models = signedIn ? await this.client.allModels() : [WORKBUDDY_INTL_FALLBACK_ROUTE]
    return models.map(model => ({
      provider,
      id: model.id,
      name: model.displayName,
      description: workBuddyModelDescription(model),
      // The same number the adapter compacts against, so the card cannot promise
      // a window the turn will not get.
      contextWindow: workBuddyContextWindow(model.contextWindow),
      defaultContextWindow: workBuddyContextWindow(model.contextWindow),
      inputModalities: model.supportsImages ? ['text', 'image'] as const : ['text'] as const,
      ...signedIn
        ? { availability: 'available' as const }
        : { availability: 'unavailable' as const, unavailableReason: 'WORKBUDDY_LOGIN_REQUIRED' },
    }))
  }

  /**
   * The reasoning ladder the live document declares for one route.
   *
   * Read from the same directory {@link resolveModel} publishes, so a tier chosen
   * as a fallback can never be one the picker does not offer. A failed read skips
   * the fallback rather than failing the turn: the caller's own body then travels
   * exactly as serialized.
   * @param model - the route to look up.
   * @returns the declared ladder, or undefined when the document declares none.
   */
  private async declaredReasoning(model: string): Promise<{ readonly efforts: readonly WorkBuddyReasoningTier[]; readonly defaultEffort: string } | undefined> {
    try {
      const known = (await this.client.allModels()).find(route => route.id === model)
      return workBuddyReasoningOptions(known)
    } catch {
      return undefined
    }
  }

  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    // The whole directory: a metered route the user switched on has to resolve
    // to its own name, context window, and reasoning ladder, and reading only
    // the free tier would answer with the generic defaults for it.
    const known = (await this.client.allModels()).find(candidate => candidate.id === model)
    const reasoning = workBuddyReasoningOptions(known)
    return {
      provider,
      id: model,
      name: known?.displayName ?? model,
      inputModalities: known?.supportsImages === true ? ['text', 'image'] : ['text'],
      context: { contextWindow: workBuddyContextWindow(known?.contextWindow) },
      defaultMaxTokens: known?.maxTokens ?? WORKBUDDY_INTL_DEFAULT_MAX_TOKENS,
      // The menu shows exactly what the product declares for this route: a route
      // that cannot stop thinking offers no "off", and a route whose product
      // tier is `high` preselects `high` instead of silently reasoning off.
      ...(reasoning === undefined ? {} : {
        reasoning: {
          efforts: [
            ...reasoning.canDisable ? [{ id: ReasoningEffortId('off'), name: 'Off' }] : [],
            ...reasoning.efforts.map(tier => ({ id: ReasoningEffortId(tier), name: workBuddyEffortLabel(tier) })),
          ],
          defaultEffort: ReasoningEffortId(reasoning.defaultEffort),
        },
      }),
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const body = prepareWorkBuddyReasoning(
      serializeRequest(options),
      options.model,
      await this.declaredReasoning(options.model),
      options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort),
    )
    let response: Response
    try {
      // The session id is the conversation identity: the chat route names the
      // conversation in three headers and prices the prefix cache by it, and a
      // turn that omitted it would start a new conversation every request.
      response = await this.client.chat(body, options.signal, {
        ...(options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) }),
      })
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError('WorkBuddy request aborted by caller', 'ABORTED', { cause: error })
      throw workBuddyLlmError(error)
    }
    if (response.body === null) throw new LlmError('WorkBuddy returned no response body', 'EMPTY_RESPONSE')
    try {
      yield* translate(parseSse(response.body))
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError('WorkBuddy request aborted by caller', 'ABORTED', { cause: error })
      if (error instanceof LlmError) throw error
      throw new LlmError('WorkBuddy stream failed', 'TRANSPORT', { cause: error })
    }
  }
}
