/**
 * Host-only TRAE connector: the account pool, the SOLO configuration directory,
 * and the LLM adapter that serves it.
 *
 * What this connector is
 * ----------------------
 * TRAE's IDE talks to its own cloud over a channel that is open to a
 * non-IDE caller for exactly one entry point (`solo_work_lite`, billed against
 * the account's `ide_credits`). A signed-in account is therefore a usable model
 * route with no API key anywhere in the story: the browser authorizes, the Host
 * holds the resulting token pair, and every turn is signed with the machine
 * identity that authorization was issued to.
 *
 * Why the pool rotates inside one turn
 * ------------------------------------
 * `ide_credits` is per account and the channel is deliberately rate limited, so
 * a turn that fails on a spent or throttled account is a turn another account
 * can still serve. The pool walk below is that answer, and the classification
 * that decides whether to continue is `upstreamStatusCategory`'s (an auth
 * refusal is account-wide; a quota or rate gate is this account's problem).
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/trae-intl
 */

import { credentialRef, type CredentialProvider, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { attributionHeaders, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { serializeRequest, translate } from './openai-wire.ts'
import { parseSse } from './wire-shared.ts'
import { asNumber, asRecord, asString } from './untrusted-json.ts'
import { llmCodeForUpstreamStatus } from './upstream-status-code.ts'
import { redactCredentialShapes } from './secret-scan.ts'
import { parseTraeFrame, prepareTraeBody, openTraeChatStream, readTraeEvents, synthesizeTraeOpenAiSse, type TraeSseEvent } from './trae/bridge.ts'
import { fetchTraeModels, selectableTraeModels } from './trae/directory.ts'
import { traeReasoningEffortsFor } from './trae/reasoning.ts'
import { claimTraeCredits } from './trae/checkin.ts'
import { exchangeTraeToken } from './trae/login.ts'
import { TRAE_DIRECTORY_LIST_TIMEOUT_MS, TRAE_MODELS_CACHE_TTL_MS, TRAE_MODELS_REFRESH_BACKOFF_MS, TRAE_TOKEN_REFRESH_SKEW_MS } from './trae/endpoints.ts'
import { TraeUpstreamError } from './trae/errors.ts'
import { traeRealmOf, TRAE_REALMS, type TraeRealm } from './trae/realms.ts'
import type { TraeAccount, TraeModel } from './trae/types.ts'
import type { FreeCodeGoCheckinAccount, FreeCodeGoCheckinReport, TraeAccountSnapshot, TraeModel as TraeModelRow } from './types.ts'

/** Host-only credential slot for the TRAE account pool. */
export const TRAE_STORE_REF: CredentialRef = credentialRef('TRAE_STORE')

/** The provider id every TRAE route is registered under. */
export const TRAE_PROVIDER_ID = 'trae'

/**
 * The context window advertised for a SOLO configuration.
 *
 * The configuration table names models but publishes no limits, and the
 * upstream truncates silently rather than refusing, so this is a floor the
 * connector can defend rather than a measurement: every model the table has
 * offered so far carries at least this much, and a larger claim would let the
 * Harness send a prompt that no SOLO configuration accepts.
 */
const TRAE_DEFAULT_CONTEXT = 128_000

/** How much output a turn asks for when the caller states no budget. */
const TRAE_DEFAULT_MAX_TOKENS = 16_384

/**
 * The route advertised before sign-in.
 *
 * The directory cannot be read without an account, so a signed-out connector
 * has nothing to enumerate. Showing one known configuration as unavailable is
 * what tells a user what signing in adds; naming a model the account may not
 * have is not a risk here, because the row cannot be selected until a session
 * exists to ask with.
 */
export const TRAE_FALLBACK_MODEL: TraeModelRow = {
  id: 'glm-5.2',
  name: 'GLM-5.2 (TRAE SOLO)',
  // The China realm's, which is also the connector's default realm: the fallback
  // stands in for a directory this client has not read yet, and it is the name a
  // China account can actually call.
  realm: 'cn',
  contextWindow: TRAE_DEFAULT_CONTEXT,
  maxTokens: TRAE_DEFAULT_MAX_TOKENS,
}

/**
 * The `LlmError` code for a failure inside an accepted SOLO stream.
 *
 * The stream's business codes are the upstream's own vocabulary and they do not
 * line up with HTTP: `1001` is the rejected sign-in, `4008` a spent `ide_credits`
 * allowance, `1005` an entitlement the plan no longer carries, and `4011` the
 * channel's rate limit. Reporting the first as `RATE_LIMIT` would send a user to
 * wait for a window that never opens, and reporting the others as `AUTH` would
 * send them to re-authorize an account that is working.
 * @param code - the business code the stream reported, when it reported one.
 * @returns the shared code.
 */
function traeErrorCode(code: number | undefined): string {
  if (code === 1001) return 'AUTH'
  // 4008 (this account's allowance is spent), 4010 (temporary risk control) and
  // 4011 (the channel's rate limit) are all "this account is out of turn right
  // now", which is what RATE_LIMIT says. 1005 is deliberately *not* here: the
  // plan simply does not include the model, and telling the Harness "rate
  // limited" invites a retry that can only fail the same way. It keeps its own
  // code so the failure ledger separates the two.
  if (code === 4008 || code === 4010 || code === 4011) return 'RATE_LIMIT'
  return code === undefined ? 'SERVER' : `UPSTREAM_${code}`
}

/** Map TRAE failures onto the shared LLM error vocabulary. */
function traeLlmError(error: unknown): LlmError {
  if (error instanceof TraeUpstreamError) {
    const code = error.code === undefined ? llmCodeForUpstreamStatus(error.status) : traeErrorCode(error.code)
    // Masked before it becomes a message. This text is the upstream's own error
    // body, and the request that produced it carried the account's access token —
    // the shared wire layers mask for exactly this reason, and an adapter that
    // quotes the body is the leak they cannot cover.
    const detail = redactCredentialShapes(error.detail).trim()
    const suffix = detail === '' ? '' : `（上游：${detail}）`
    // The business codes name causes the HTTP status cannot: a 200-OK stream
    // refuses a spent allowance, a plan gate and a bad model name in exactly the
    // same envelope. Each gets the sentence that tells the user what to do — a
    // plan gate is not a quota, and a model this realm does not know is not a
    // reason to sign in again.
    const message = code === 'AUTH'
      ? `TRAE 登录凭据已被上游拒绝，请在设置中重新登录。 TRAE sign-in was rejected by the upstream; sign in again in Settings.${suffix}`
      : error.code === 4008
        ? `TRAE 免费额度已用尽，请等待每日重置或换一个账号。 TRAE free credits are used up; wait for the daily reset or add another account.${suffix}`
        : error.code === 1005
          ? `当前套餐不包含这个模型（上游 1005），换一个模型即可。 The current plan does not include this model (upstream 1005); pick another model.${suffix}`
          : error.code === 4001
            ? `上游不认这个模型名（4001）：该名称可能属于另一个区域（国内版 / 国际版的模型目录几乎不重叠）。 The upstream rejected this model name (4001): it may belong to the other deployment — the China and global catalogs are almost disjoint.${suffix}`
            : error.code === 4017
              ? `上游风控：同一设备上登录的账号过多（4017），换设备或等风控冷却。 Upstream risk control: too many accounts on this device (4017); use another device or wait for the cooldown.${suffix}`
              : error.code === 4010
                ? `上游临时风控拒绝了这次请求（4010），稍后重试即可。 Upstream risk control refused this request temporarily (4010); retry later.${suffix}`
                : `TRAE 请求失败（HTTP ${error.status}），请稍后重试。 TRAE request failed (HTTP ${error.status}); retry later.${suffix}`
    return new LlmError(message, code, { status: error.status })
  }
  if (error instanceof Error && error.message.startsWith('TRAE_LOGIN_REQUIRED')) return new LlmError(error.message, 'AUTH', { cause: error })
  return new LlmError('TRAE request failed', 'TRANSPORT', { cause: error })
}

/** The addressable id of a stored TRAE account row. */
export function traeAccountIdOf(row: Record<string, unknown>): string | undefined {
  const id = asString(row.id)
  if (id !== undefined && id !== '') return id
  const uid = asString(row.uid)
  if (uid !== undefined && uid !== '') return uid
  const deviceId = asString(row.deviceId)
  return deviceId === undefined || deviceId === '' ? undefined : `trae-${deviceId.slice(-12)}`
}

/**
 * Read the TRAE account pool. Offline: the card and the picker ask on every
 * render.
 * @param credentials - the credential provider, or `undefined` before it mounts.
 * @returns the stored accounts, in stored order.
 */
export async function readTraeAccounts(credentials: CredentialProvider | undefined): Promise<readonly TraeAccount[]> {
  const resolved = await credentials?.resolve(TRAE_STORE_REF)
  if (resolved?.value === undefined) return []
  try {
    const parsed = asRecord(JSON.parse(resolved.value))
    const rows = Array.isArray(parsed.accounts) ? parsed.accounts : []
    const accounts: TraeAccount[] = []
    for (const item of rows) {
      const row = asRecord(item)
      const id = traeAccountIdOf(row)
      const accessToken = asString(row.accessToken)
      const refreshToken = asString(row.refreshToken)
      if (id === undefined || ((accessToken ?? '') === '' && (refreshToken ?? '') === '')) continue
      const enterpriseId = asString(row.enterpriseId)
      const userRegion = asString(row.userRegion)
      accounts.push({
        id,
        // A row written before realms existed reads as China, which is what every
        // account stored until the international connector was added is.
        realm: traeRealmOf(row.realm),
        ...(userRegion === undefined || userRegion === '' ? {} : { userRegion }),
        uid: asString(row.uid) ?? '',
        nickname: asString(row.nickname) ?? '',
        ...(enterpriseId === undefined || enterpriseId === '' ? {} : { enterpriseId }),
        machineId: asString(row.machineId) ?? '',
        deviceId: asString(row.deviceId) ?? '',
        accessToken: accessToken ?? '',
        refreshToken: refreshToken ?? '',
        expiresAt: asNumber(row.expiresAt) ?? 0,
        createdAt: asNumber(row.createdAt) ?? 0,
        lastChecked: asNumber(row.lastChecked) ?? 0,
      })
    }
    return accounts
  } catch {
    return []
  }
}

/**
 * The account the user picked, as the vault recorded it.
 * @param credentials - the credential provider, or `undefined` before it mounts.
 * @returns the selected account id, or `undefined` when none is recorded.
 */
export async function readTraeActiveId(credentials: CredentialProvider | undefined): Promise<string | undefined> {
  const resolved = await credentials?.resolve(TRAE_STORE_REF)
  if (resolved?.value === undefined) return undefined
  try {
    const value = asString(asRecord(JSON.parse(resolved.value)).activeAccountId)
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

/**
 * Map one stored account to its browser-safe row.
 *
 * The label prefers the account's own display name, falls back to the uid it
 * belongs to, and only then to the local id: the id is derived from the uid, so
 * it is the one of the three that says least about whose account this is.
 * @param account - the stored row.
 * @returns the row the browser renders.
 */
export function traeAccountSnapshot(account: TraeAccount): TraeAccountSnapshot {
  // A session with no refresh token and an access token that has expired cannot
  // be renewed by this Host; the row says so rather than looking usable.
  const expired = account.refreshToken === '' && account.expiresAt > 0 && account.expiresAt * 1000 <= Date.now()
  const label = account.nickname !== ''
    ? account.nickname
    : account.uid !== '' ? `TRAE ${account.uid}` : account.id
  return {
    id: account.id,
    label,
    realm: account.realm,
    ...(account.uid === '' ? {} : { userId: account.uid }),
    ...(account.expiresAt === 0 ? {} : { expiresAt: account.expiresAt }),
    status: expired ? 'reauth-required' : 'authenticated',
  }
}

/**
 * Map one configuration to its browser-safe row.
 *
 * The limits are the connector's own constants rather than the directory's,
 * because SOLO publishes none — the picker and the card read the same numbers
 * the adapter enforces, so neither can promise more than a turn will use.
 * @param model - the directory row.
 * @returns the row the browser renders.
 */
export function traeModelRow(model: TraeModel, realm: TraeRealm = 'cn'): TraeModelRow {
  return {
    id: model.id,
    name: model.displayName,
    realm,
    contextWindow: TRAE_DEFAULT_CONTEXT,
    maxTokens: TRAE_DEFAULT_MAX_TOKENS,
  }
}

/** The pool with the selected account moved to the front. */
function selectedFirst(pool: readonly TraeAccount[], selected: string | undefined): readonly TraeAccount[] {
  if (selected === undefined) return pool
  const index = pool.findIndex(account => account.id === selected)
  return index <= 0 ? pool : [...pool.slice(index), ...pool.slice(0, index)]
}

/** Whether this account's access token is close enough to expiry to rotate. */
function needsRotation(account: TraeAccount, now: number): boolean {
  if (account.refreshToken === '') return false
  if (account.accessToken === '') return true
  if (account.expiresAt === 0) return false
  return account.expiresAt * 1000 - now <= TRAE_TOKEN_REFRESH_SKEW_MS
}

/**
 * The TRAE account pool. One instance is shared by the settings card, the
 * directory read, and the chat adapter.
 */
export class TraeClient {
  // One cache per realm, because the catalogs are per realm and near-disjoint: a
  // single slot would hand a China account the international list (whose names it
  // answers 4001 for) for ten minutes after any read, and the realm that happened
  // to be read last would be the one the picker showed.
  private readonly modelsCache = new Map<TraeRealm, { readonly expiresAt: number; readonly models: readonly TraeModel[] }>()
  private readonly modelsPromise = new Map<TraeRealm, Promise<readonly TraeModel[]>>()

  /**
   * @param credentials - the vault the account pool lives in.
   * @param persistAccount - writes a rotated or updated account row back.
   */
  constructor(
    private readonly credentials: CredentialProvider,
    private readonly persistAccount: (account: TraeAccount) => Promise<void>,
  ) {}

  /** The stored account pool. */
  async accounts(): Promise<readonly TraeAccount[]> {
    return readTraeAccounts(this.credentials)
  }

  /** Whether any account is signed in. */
  async signedIn(): Promise<boolean> {
    return (await this.accounts()).length > 0
  }

  /**
   * Claim today's credits for every stored account.
   *
   * One account at a time, like every other sweep of this pool: the accounts sit
   * behind one upstream, and firing them together is how a pool gets throttled as
   * a group — which the claim endpoint answers with `9074`, the very failure the
   * per-account retry ladder exists to absorb.
   *
   * A per-account refusal is reported rather than thrown, because the credits that
   * did arrive belong to the accounts that collected them. The token is rotated
   * first, so a run on a day-old session still signs in rather than answering 401.
   * @param signal - aborts the run.
   * @returns the run's report.
   */
  async checkin(signal?: AbortSignal): Promise<FreeCodeGoCheckinReport> {
    const accounts = await this.accounts()
    const rows: FreeCodeGoCheckinAccount[] = []
    let credits = 0
    for (const account of accounts) {
      const label = traeAccountSnapshot(account).label
      try {
        const outcome = await claimTraeCredits(await this.withFreshToken(account, signal), signal)
        credits += outcome.credits
        rows.push({ accountId: account.id, label, outcome: outcome.status, credits: outcome.credits, message: outcome.message })
      } catch (error) {
        // `TraeUpstreamError`'s message carries up to 300 characters of the
        // upstream body, and this report is what crosses to the browser — so the
        // masking happens here, at the last point that knows the request the text
        // came from.
        rows.push({ accountId: account.id, label, outcome: 'failed', credits: 0, message: redactCredentialShapes(error instanceof Error ? error.message : String(error)) })
      }
    }
    return { checkedAt: Date.now(), credits, accounts: rows }
  }

  /** Drop the cached directories so the next read hits the network. */
  invalidateModels(): void {
    this.modelsCache.clear()
  }

  /**
   * The account with a token that can be used now.
   *
   * The rotation is persisted before the caller uses it: a refresh token is
   * spent by the exchange, so a rotation that is not written back leaves the
   * next turn holding a token the upstream has already invalidated.
   * @param account - the stored row.
   * @param signal - aborts the exchange.
   * @returns the account to sign with.
   */
  private async withFreshToken(account: TraeAccount, signal?: AbortSignal): Promise<TraeAccount> {
    if (!needsRotation(account, Date.now())) return account
    const token = await exchangeTraeToken(account.refreshToken, account.realm, signal)
    const rotated: TraeAccount = {
      ...account,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      lastChecked: Math.floor(Date.now() / 1000),
    }
    await this.persistAccount(rotated).catch(() => undefined)
    return rotated
  }

  /**
   * Read (and cache) one realm's configuration directory.
   *
   * Scoped to a realm because the table is: it is served by that realm's chat host
   * with that realm's product identity, and the two list almost disjoint names.
   *
   * A caller that is only listing models passes `serveStale`, which is what keeps
   * a picker from waiting on the upstream: the last read answers, and the next one
   * starts behind it. Routing does not pass it, because a stale list there is how a
   * turn gets sent to the realm that answers `4001`.
   * @param realm - the deployment to read.
   * @param signal - aborts the read.
   * @param options - whether a stale list may answer, and how long a read may take.
   * @returns the directory, or an empty list when no account of that realm could answer.
   */
  private async realmModels(
    realm: TraeRealm,
    signal?: AbortSignal,
    options: { readonly serveStale?: boolean; readonly timeoutMs?: number } = {},
  ): Promise<readonly TraeModel[]> {
    const cached = this.modelsCache.get(realm)
    if (cached !== undefined) {
      if (cached.expiresAt > Date.now()) return cached.models
      if (options.serveStale === true) {
        void this.refreshRealm(realm, options.timeoutMs)
        return cached.models
      }
    }
    return await this.readRealm(realm, signal, options.timeoutMs)
  }

  /**
   * Re-read one realm behind a caller that already has its answer.
   *
   * A failed refresh keeps the list it was refreshing: the table does not empty
   * itself because a socket stalled, and publishing the failure's empty list would
   * make every model of that realm vanish from the picker until it came back.
   * @param realm - the deployment to re-read.
   * @param timeoutMs - how long this background read may take.
   */
  private async refreshRealm(realm: TraeRealm, timeoutMs?: number): Promise<void> {
    const previous = this.modelsCache.get(realm)
    const models = await this.readRealm(realm, undefined, timeoutMs).catch(() => [] as readonly TraeModel[])
    if (models.length > 0 || previous === undefined) return
    this.modelsCache.set(realm, { expiresAt: Date.now() + TRAE_MODELS_REFRESH_BACKOFF_MS, models: previous.models })
  }

  /**
   * Read one realm's table, sharing one read between callers that want it at once.
   * @param realm - the deployment to read.
   * @param signal - aborts the read.
   * @param timeoutMs - how long the read may take when the caller brought no signal.
   * @returns the parsed directory, empty when no account of that realm could answer.
   */
  private async readRealm(realm: TraeRealm, signal?: AbortSignal, timeoutMs?: number): Promise<readonly TraeModel[]> {
    const inFlight = this.modelsPromise.get(realm)
    if (inFlight !== undefined) return inFlight
    const operation = (async (): Promise<readonly TraeModel[]> => {
      for (const account of await this.accounts()) {
        if (account.realm !== realm) continue
        try {
          const models = await fetchTraeModels(await this.withFreshToken(account, signal), signal, timeoutMs)
          if (models.length > 0) return models
        } catch {
          // Try the next account of this realm, then fall back to an empty list.
        }
      }
      return []
    })()
    this.modelsPromise.set(realm, operation)
    try {
      const models = await operation
      // An aborted read is not evidence about a realm. Its empty answer is kept out
      // of the cache, because caching it would hide that realm's models — and with
      // them its routing — for the whole TTL, from one cancelled turn.
      if (signal?.aborted !== true) this.modelsCache.set(realm, { expiresAt: Date.now() + TRAE_MODELS_CACHE_TTL_MS, models })
      return models
    } finally {
      if (this.modelsPromise.get(realm) === operation) this.modelsPromise.delete(realm)
    }
  }

  /**
   * The configuration table, as the picker and the card render it.
   *
   * The union of the realms the pool holds accounts for, the active account's realm
   * first. A name both realms list is emitted once, under whichever realm is tried
   * first — the three shared names are served by either, and two rows with one id
   * would be two picker entries the Harness cannot tell apart.
   *
   * Only the configurations a user may choose reach the picker, and the filter runs
   * before the dedupe so a name both deployments carry is emitted under the one that
   * actually offers it. The list may lag the upstream by one refresh: this is the
   * path a picker blocks on, so it answers from the last read and refreshes behind
   * it rather than making an open menu wait on a socket.
   * @returns the rows, deduplicated by model id.
   */
  async directoryModels(): Promise<readonly TraeModelRow[]> {
    if (!(await this.signedIn())) return []
    const selected = await readTraeActiveId(this.credentials)
    const pool = await this.accounts()
    const active = pool.find(account => account.id === selected)?.realm
    const realms = TRAE_REALMS.filter(realm => pool.some(account => account.realm === realm))
    const ordered = active === undefined ? realms : [active, ...realms.filter(realm => realm !== active)]
    // Read together, not one after another: the model catalog the picker opens with
    // builds every provider in parallel and waits for the slowest one, so serial
    // realms make this connector cost the sum instead of the worst single read.
    const listed = await Promise.all(ordered.map(async realm => [realm, await this.realmModels(realm, undefined, {
      serveStale: true,
      timeoutMs: TRAE_DIRECTORY_LIST_TIMEOUT_MS,
    })] as const))
    const rows: TraeModelRow[] = []
    const seen = new Set<string>()
    // Merged in the realm order the decision uses, so which realm names a shared row
    // does not depend on which read answered first.
    for (const [realm, models] of listed) {
      for (const model of selectableTraeModels(models)) {
        if (seen.has(model.id)) continue
        seen.add(model.id)
        rows.push(traeModelRow(model, realm))
      }
    }
    return rows
  }

  /**
   * The realm whose catalog lists one model, when exactly one does.
   *
   * The catalogs are read when they are not cached, because "unread" is not
   * neutral here. A realm with no cached list contributes no hit, so a name the
   * unread realm owns looks like a name both realms lack — and then the active
   * account is tried first and answers the wrong-realm `4001 param is invalid`,
   * which names nothing about regions and does not rotate (see
   * `isAccountFailover`). That is exactly what a Host restart used to produce: the
   * cache lives in memory, the picker was never opened in this process, and a
   * global model requested against a China active account failed with a message
   * about a bad parameter. The extra read is bounded — one request per realm, the
   * same request the picker makes, and it is cached for ten minutes afterwards.
   * @param model - the requested model name.
   * @param pool - the stored accounts, already in hand from the turn.
   * @param signal - aborts the catalogs this has to read.
   * @returns the realm to prefer, or `undefined` when the name does not say.
   */
  private async realmServingModel(model: string, pool: readonly TraeAccount[], signal?: AbortSignal): Promise<TraeRealm | undefined> {
    const realms = TRAE_REALMS.filter(realm => pool.some(account => account.realm === realm))
    // One realm in the pool: there is no routing decision to make and no other
    // account to route to, so reading a catalog to confirm it would be a request
    // no turn needs. This is the case a China-only pool has always been in.
    if (realms.length < 2) return undefined
    for (const realm of realms) {
      if (this.modelsCache.has(realm)) continue
      // A catalog that cannot be read leaves no opinion, which is the same answer
      // this had before the read — worth a request, never worth the turn.
      await this.realmModels(realm, signal).catch(() => [])
    }
    const hits = realms.filter(realm => (this.modelsCache.get(realm)?.models ?? []).some(candidate => candidate.id === model))
    return hits.length === 1 ? hits[0] : undefined
  }

  /**
   * Stream one chat completion, rotating accounts on account-level failures.
   *
   * Two things make the rotation real rather than decorative. First, the account
   * order follows the model: the two catalogs are near-disjoint, and a name sent to
   * the other realm is refused with `4001 param is invalid`, which names nothing
   * about regions. Second, the *first* frame is read before this method returns,
   * because the account-level refusals arrive inside an accepted stream (HTTP 200
   * carrying an `error` event) — a loop that only caught transport failures would
   * never see a spent quota or a rejected session at all, which is exactly the
   * rotation this pool exists for.
   * @param body - the OpenAI-compatible body the adapter serialized.
   * @param signal - aborts the request when the caller cancels.
   * @returns the synthesized OpenAI-compatible response.
   */
  async chat(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const pool = await this.accounts()
    if (pool.length === 0) throw new Error('TRAE_LOGIN_REQUIRED: sign in to TRAE first')
    const selected = await readTraeActiveId(this.credentials)
    const model = asString(body.model) ?? TRAE_FALLBACK_MODEL.id
    const preferred = await this.realmServingModel(model, pool, signal)
    const ordered = selectedFirst(pool, selected)
    const accounts = preferred === undefined
      ? ordered
      : [...ordered.filter(account => account.realm === preferred), ...ordered.filter(account => account.realm !== preferred)]
    let lastError: unknown
    for (const account of accounts) {
      try {
        const session = await this.withFreshToken(account, signal)
        const raw = await openTraeChatStream(session, prepareTraeBody(body, model), signal, attributionHeaders())
        if (raw.body === null) throw new TraeUpstreamError(502, 'empty upstream stream')
        const events = readTraeEvents(raw.body)
        const head = await events.next()
        if (head.done === true) throw new TraeUpstreamError(502, 'empty upstream stream')
        // Throws for an `error` frame, which is where a spent quota or a rejected
        // session actually arrives. A refusal that names the model instead fails
        // here and never rotates (see `isAccountFailover`).
        parseTraeFrame(head.value)
        return new Response(synthesizeTraeOpenAiSse(replayTraeFrame(head.value, events)), {
          headers: { 'content-type': 'text/event-stream' },
        })
      } catch (error) {
        lastError = error
        // Past the first frame the answer is already committed to the caller, so a
        // failure there cannot rotate. Before it, only an account-level refusal is
        // worth another account.
        if (!isAccountFailover(error)) throw error
      }
    }
    throw lastError instanceof Error ? lastError : new Error('TRAE request failed')
  }
}

/**
 * The upstream business codes a different account can answer.
 *
 * From the measured protocol notes: `4008` is the account's own allowance spent,
 * `1001` a session the upstream no longer accepts, and `4010` a temporary
 * risk-control refusal that clears on its own. `1005` (the plan not including this
 * model), `4001` (a name or parameter this realm rejects) and `4017` (too many
 * accounts on this device) are not here: every account answers them identically, so
 * walking the pool on one spends the whole pool to reach the same refusal.
 */
const TRAE_ACCOUNT_FAILOVER_CODES: ReadonlySet<number> = new Set([4008, 1001, 4010])

/**
 * Whether another account could serve this failure.
 *
 * A business code decides by {@link TRAE_ACCOUNT_FAILOVER_CODES}. A transport-level
 * refusal has no code, so the status decides: `401` says this session is dead and
 * `429` that this account is out of turn, while a plan gate (`402`/`403`), a
 * request error and the upstream's own `5xx` are answered the same way by every
 * account. A failure that is not an upstream refusal at all — a reset socket, a
 * timeout — is treated as worth one more account, because nothing in it says the
 * next one would fail the same way.
 * @param error - the failure a chat attempt raised.
 * @returns whether the pool walk should continue.
 */
function isAccountFailover(error: unknown): boolean {
  if (!(error instanceof TraeUpstreamError)) return true
  if (error.code !== undefined) return TRAE_ACCOUNT_FAILOVER_CODES.has(error.code)
  return error.status === 401 || error.status === 429
}

/** Re-yield the frame that was read ahead, then the rest of the stream. */
async function* replayTraeFrame(
  first: TraeSseEvent,
  rest: AsyncGenerator<TraeSseEvent>,
): AsyncGenerator<TraeSseEvent> {
  yield first
  for await (const event of rest) yield event
}

/**
 * The TRAE provider adapter.
 *
 * It owns request serialization because the body the upstream accepts is its own
 * shape (see `trae/bridge.ts`) rather than a generic OpenAI request, and because
 * the pool rotates accounts inside one turn: the caller's stream has to survive
 * an account change without the Harness knowing one happened.
 */
export class TraeAdapter extends LlmAdapter {
  constructor(private readonly client: TraeClient) { super() }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'TRAE' }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const signedIn = await this.client.signedIn()
    const models = signedIn ? await this.client.directoryModels() : [TRAE_FALLBACK_MODEL]
    return models.map(model => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: ['text'] as const,
      ...signedIn
        ? { availability: 'available' as const }
        : { availability: 'unavailable' as const, unavailableReason: 'TRAE_LOGIN_REQUIRED' },
    }))
  }

  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const known = (await this.client.directoryModels()).find(candidate => candidate.id === model)
    // The ladder is per family, not per provider: SOLO has no reasoning field, so
    // each level is a system-prompt block, and only the families whose wording was
    // measured have one (see `trae/reasoning.ts`). A model outside them gets no
    // control, which is the honest answer rather than a menu that changes nothing.
    const efforts = traeReasoningEffortsFor(model)
    return {
      provider,
      id: model,
      name: known?.name ?? TRAE_FALLBACK_MODEL.name,
      inputModalities: ['text'],
      context: { contextWindow: TRAE_DEFAULT_CONTEXT },
      defaultMaxTokens: TRAE_DEFAULT_MAX_TOKENS,
      // The stream's own `reasoning_content` is passed through as reasoning chunks
      // regardless of what this menu says; the control steers how much thinking is
      // asked for, it does not switch thinking on.
      ...(efforts === undefined
        ? {}
        : {
          reasoning: {
            efforts: efforts.map(effort => ({
              id: ReasoningEffortId(effort),
              name: effort.slice(0, 1).toUpperCase() + effort.slice(1),
            })),
            // `off` is "send nothing and let the model decide", which is also what a
            // session that never touched this control asks for.
            defaultEffort: ReasoningEffortId('off'),
          },
        }),
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const body = serializeRequest(options, { reasoningWire: 'standard' })
    let response: Response
    try {
      response = await this.client.chat(body, options.signal)
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError('TRAE request aborted by caller', 'ABORTED', { cause: error })
      throw traeLlmError(error)
    }
    if (response.body === null) throw new LlmError('TRAE returned no response body', 'EMPTY_RESPONSE')
    try {
      yield* translate(parseSse(response.body))
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError('TRAE request aborted by caller', 'ABORTED', { cause: error })
      if (error instanceof LlmError) throw error
      throw traeLlmError(error)
    }
  }
}
