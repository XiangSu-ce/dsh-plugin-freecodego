/**
 * Host-only Qoder connector: the account pool, the free-route directory, and
 * the LLM adapter that serves it.
 *
 * Qoder credentials (a `dt-` device token) live in the Host vault. A session
 * built from one account signs every API call with the cosy protocol, and the
 * derived device fingerprint is stable per account.
 *
 * The free Qwen flash route is what this connector advertises as free, and the
 * whole enabled directory is listed beside it so a metered route is visible
 * (default-off) in the settings checklist rather than unreachable. The
 * credential is per account, so a rejected account rotates to the next one
 * inside a single turn.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/qoder-intl
 */

import { credentialRef, type CredentialProvider, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { attributionHeaders, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { serializeRequest, translate } from './openai-wire.ts'
import { parseSse } from './wire-shared.ts'
import { asNumber, asRecord, asString } from './untrusted-json.ts'
import { llmCodeForUpstreamStatus } from './upstream-status-code.ts'
import { redactCredentialShapes } from './secret-scan.ts'
import { createQoderSession, deriveMachineId, deriveMachineToken, deriveMachineType, fingerprintSeed } from './qoder/cosy.ts'
import { normalizeQoderRegion } from './qoder/endpoints.ts'
import { fetchQoderModels, selectFreeQoderModels } from './qoder/directory.ts'
import { buildQoderChatBody, openQoderChatStream, QoderUpstreamError, synthesizeOpenAiSse } from './qoder/bridge.ts'
import { fetchQoderQuota } from './qoder/oauth.ts'
import { claimQoderCampaigns } from './qoder/checkin.ts'
import type { QoderAccount, QoderModel, QoderQuota, QoderSession } from './qoder/types.ts'
import type { FreeCodeGoCheckinAccount, FreeCodeGoCheckinReport, QoderModelInfo } from './types.ts'
// The browser-safe rows and the thinking contract live in `qoder/rows.ts`; they
// are re-exported here because this module is the connector's public entrypoint
// and every consumer names them through it.
import { QODER_FALLBACK_MODEL, QODER_REASONING_DEFAULT, QODER_REASONING_EFFORTS, qoderAccountInfo, qoderModelDescription, qoderModelInfo, reasoningDisabled } from './qoder/rows.ts'

export { QODER_FALLBACK_MODEL, qoderAccountInfo, qoderModelDescription, qoderModelInfo } from './qoder/rows.ts'

/** Host-only credential slot for the Qoder account pool. */
export const QODER_STORE_REF: CredentialRef = credentialRef('QODER_STORE')

const QODER_MODELS_CACHE_TTL_MS = 5 * 60_000
const QODER_DEFAULT_CONTEXT = 128_000

/** The addressable id of a stored Qoder account row. */
export function qoderAccountId(row: Record<string, unknown>): string | undefined {
  return asString(row.id) ?? ((): string | undefined => {
    const deviceToken = asString(row.deviceToken)
    return deviceToken === undefined ? undefined : `qoder-${deviceToken.slice(-12)}`
  })()
}

/**
 * Read the Qoder account pool. Offline: the card and the picker ask on every
 * render.
 * @param credentials - the credential provider, or `undefined` before it mounts.
 * @returns the stored accounts, in backend order.
 */
export async function readQoderAccounts(credentials: CredentialProvider | undefined): Promise<readonly QoderAccount[]> {
  const resolved = await credentials?.resolve(QODER_STORE_REF)
  if (resolved?.value === undefined) return []
  try {
    const parsed = asRecord(JSON.parse(resolved.value))
    const rows = Array.isArray(parsed.accounts) ? parsed.accounts : []
    return rows.map((item): QoderAccount | undefined => {
      const row = asRecord(item)
      const deviceToken = asString(row.deviceToken)
      if (deviceToken === undefined || deviceToken === '') return undefined
      const id = qoderAccountId(row)
      if (id === undefined) return undefined
      const refreshToken = asString(row.refreshToken)
      const uid = asString(row.uid)
      const name = asString(row.name)
      const email = asString(row.email)
      const userType = asString(row.userType)
      const plan = asString(row.plan)
      const organizationId = asString(row.organizationId)
      const organizationName = asString(row.organizationName)
      const quotaError = asString(row.quotaError)
      const quota = asRecord(row.quota)
      return {
        id,
        region: normalizeQoderRegion(row.region),
        deviceToken,
        ...(refreshToken === undefined ? {} : { refreshToken }),
        ...(uid === undefined ? {} : { uid }),
        ...(name === undefined ? {} : { name }),
        ...(email === undefined ? {} : { email }),
        ...(userType === undefined ? {} : { userType }),
        ...(plan === undefined ? {} : { plan }),
        ...(organizationId === undefined ? {} : { organizationId }),
        ...(organizationName === undefined ? {} : { organizationName }),
        createdAt: asNumber(row.createdAt) ?? 0,
        lastChecked: asNumber(row.lastChecked) ?? 0,
        ...(Object.keys(quota).length === 0 ? {} : { quota: quota as unknown as QoderQuota }),
        ...(quotaError === undefined ? {} : { quotaError }),
      }
    }).filter((account): account is QoderAccount => account !== undefined)
  } catch {
    return []
  }
}

/**
 * The account the user picked, as the vault recorded it.
 * @param credentials - the credential provider, or `undefined` before it mounts.
 * @returns the selected account id, or `undefined` when none is recorded.
 */
export async function readQoderActiveId(credentials: CredentialProvider | undefined): Promise<string | undefined> {
  const resolved = await credentials?.resolve(QODER_STORE_REF)
  if (resolved?.value === undefined) return undefined
  try {
    return asString(asRecord(JSON.parse(resolved.value)).activeAccountId)
  } catch {
    return undefined
  }
}

/** The pool with the selected account moved to the front. */
function selectedFirst(pool: readonly QoderAccount[], selected: string | undefined): readonly QoderAccount[] {
  if (selected === undefined) return pool
  const index = pool.findIndex(account => account.id === selected)
  return index <= 0 ? pool : [...pool.slice(index), ...pool.slice(0, index)]
}

/** Build the cosy session for one stored account, offline. */
function sessionFor(account: QoderAccount): QoderSession {
  const uid = account.uid ?? ''
  const seed = fingerprintSeed(uid, account.deviceToken)
  const identityUid = uid === '' ? account.id : uid
  const identity = {
    name: account.name ?? '',
    aid: identityUid,
    uid: identityUid,
    ...(account.organizationId === undefined ? {} : { organizationId: account.organizationId }),
    ...(account.organizationName === undefined ? {} : { organizationName: account.organizationName }),
    userType: account.userType ?? 'personal_standard',
    securityOauthToken: account.deviceToken,
    ...(account.refreshToken === undefined ? {} : { refreshToken: account.refreshToken }),
  }
  return createQoderSession(
    identity,
    deriveMachineId(seed),
    deriveMachineToken(seed),
    deriveMachineType(seed),
    account.region,
  )
}

/** Map Qoder failures onto the shared LLM error vocabulary. */
function qoderLlmError(error: unknown): LlmError {
  if (error instanceof QoderUpstreamError) {
    const code = llmCodeForUpstreamStatus(error.status)
    // The same masking the Trae mapper needs, for the same reason: this text is
    // the upstream's own error body, quoted out of a request whose headers carried
    // the account's device token.
    const detail = redactCredentialShapes(error.detail).trim()
    const suffix = detail === '' ? '' : `（上游：${detail}）`
    const message = error.status === 401
      ? `Qoder 登录凭据已被上游拒绝，请在设置中重新登录。 Qoder sign-in was rejected by the upstream; sign in again in Settings.${suffix}`
      : `Qoder 请求失败（HTTP ${error.status}），请稍后重试。 Qoder request failed (HTTP ${error.status}); retry later.${suffix}`
    return new LlmError(message, code, { status: error.status })
  }
  if (error instanceof Error && error.message.startsWith('QODER_LOGIN_REQUIRED')) return new LlmError(error.message, 'AUTH', { cause: error })
  return new LlmError('Qoder request failed', 'TRANSPORT', { cause: error })
}

/**
 * The Qoder account pool. One instance is shared by the settings card, the
 * directory read, and the chat adapter.
 */
export class QoderClient {
  private readonly sessions = new Map<string, QoderSession>()
  private modelsCache: { readonly expiresAt: number; readonly models: readonly QoderModel[] } | undefined
  private modelsPromise: Promise<readonly QoderModel[]> | undefined

  constructor(
    private readonly credentials: CredentialProvider,
    private readonly persistTokens: (account: QoderAccount) => Promise<void>,
  ) {}

  /** The stored account pool. */
  async accounts(): Promise<readonly QoderAccount[]> {
    return readQoderAccounts(this.credentials)
  }

  /** Whether any account is signed in. */
  async signedIn(): Promise<boolean> {
    return (await this.accounts()).length > 0
  }

  /** A cached session for one account. */
  private session(account: QoderAccount): QoderSession {
    const cached = this.sessions.get(account.id)
    if (cached !== undefined && cached.identity.securityOauthToken === account.deviceToken) return cached
    const session = sessionFor(account)
    this.sessions.set(account.id, session)
    return session
  }

  /** Drop the cached directory so the next read hits the network. */
  invalidateModels(): void {
    this.modelsCache = undefined
  }

  /** Read (and cache) the full model directory. */
  private async models(): Promise<readonly QoderModel[]> {
    const cached = this.modelsCache
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.models
    const inFlight = this.modelsPromise
    if (inFlight !== undefined) return inFlight
    const operation = (async (): Promise<readonly QoderModel[]> => {
      const pool = await this.accounts()
      for (const account of pool) {
        try {
          const models = await fetchQoderModels(this.session(account))
          if (models.length > 0) return models
        } catch {
          // Try the next account, then fall back to an empty directory.
        }
      }
      return []
    })()
    this.modelsPromise = operation
    try {
      const models = await operation
      this.modelsCache = { expiresAt: Date.now() + QODER_MODELS_CACHE_TTL_MS, models }
      return models
    } finally {
      if (this.modelsPromise === operation) this.modelsPromise = undefined
    }
  }

  /** The free Qwen flash route, when the product offers it. */
  async freeModels(): Promise<readonly QoderModelInfo[]> {
    if (!(await this.signedIn())) return []
    return selectFreeQoderModels(await this.models()).map(qoderModelInfo)
  }

  /**
   * Every enabled route the directory declares, free or metered.
   *
   * {@link freeModels} answers what this connector advertises as free; this
   * answers what the account can reach. The settings checklist needs the second
   * so a metered route is *listable* — a route that never reached the list could
   * never be switched on, which would make the checklist's "off" a decision the
   * user cannot revisit.
   * @returns the browser-safe rows, in directory order; empty when signed out.
   */
  async allModels(): Promise<readonly QoderModelInfo[]> {
    if (!(await this.signedIn())) return []
    return (await this.models()).map(qoderModelInfo)
  }

  /** Read one account's quota snapshot. */
  async quota(account: QoderAccount): Promise<QoderQuota> {
    return fetchQoderQuota(account.region, account.deviceToken)
  }

  /**
   * Claim today's campaign credits for every account in the pool.
   *
   * The campaign id changes daily, so every run reads the list first; the same
   * read also says whether the campaign is running, which is the difference
   * between "nothing to collect" and "collection is closed".
   *
   * Sequential on purpose: these are accounts on one upstream, and a parallel
   * sweep is how a pool gets rate limited as a group. A refusal is recorded per
   * account instead of thrown, so the credits that did arrive are still reported.
   * @param signal - aborts the run.
   * @returns the run's report.
   */
  async checkin(signal?: AbortSignal): Promise<FreeCodeGoCheckinReport> {
    const accounts = await this.accounts()
    const rows: FreeCodeGoCheckinAccount[] = []
    let credits = 0
    for (const account of accounts) {
      const info = qoderAccountInfo(account)
      // An empty string is a present value, so a `??` chain would label the row
      // with one: the fallback has to skip empties as well as undefineds.
      const label = [info.name, info.email].find(value => value !== undefined && value !== '') ?? info.id
      try {
        const outcome = await claimQoderCampaigns(account.region, account.deviceToken, signal)
        credits += outcome.credits
        rows.push({
          accountId: account.id,
          label,
          outcome: outcome.status,
          credits: outcome.credits,
          message: outcome.message,
          ...(outcome.refused === undefined ? {} : { refused: outcome.refused }),
        })
      } catch (error) {
        // Masked here because this report is what crosses to the browser, and the
        // refusal it reports came from a request carrying the account's token.
        rows.push({ accountId: account.id, label, outcome: 'failed', credits: 0, message: redactCredentialShapes(error instanceof Error ? error.message : String(error)) })
      }
    }
    return { checkedAt: Date.now(), credits, accounts: rows }
  }

  /** Persist rotated tokens (best effort; a failure costs one extra read). */
  private async persist(account: QoderAccount): Promise<void> {
    await this.persistTokens(account).catch(() => undefined)
  }

  /**
   * Stream one chat completion, rotating accounts on auth failures.
   * @param body - the OpenAI-compatible body the adapter serialized.
   * @param signal - aborts the request when the caller cancels.
   * @returns the synthesized OpenAI-compatible response.
   */
  async chat(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const pool = await this.accounts()
    if (pool.length === 0) throw new Error('QODER_LOGIN_REQUIRED: sign in to Qoder first')
    const selected = await readQoderActiveId(this.credentials)
    const ordered = selectedFirst(pool, selected)
    const model = asString(body.model) ?? QODER_FALLBACK_MODEL.id
    const directory = await this.models().catch(() => [] as readonly QoderModel[])
    const known = directory.find(candidate => candidate.key === model)
    const messages = Array.isArray(body.messages) ? body.messages : []
    const maxTokens = asNumber(body.max_tokens)
    // The requested level drives the flag. Before this, the selector was inert:
    // the body carried whatever the directory said about the model and the
    // caller's choice was dropped. An untouched menu still reasons, because
    // `defaultEffort` is materialized into the request before it reaches here.
    const isReasoning = !reasoningDisabled(body.reasoning_effort)
    let lastError: unknown
    for (const account of ordered) {
      const session = this.session(account)
      const requestBody = buildQoderChatBody(
        {
          messages,
          ...(body.tools === undefined ? {} : { tools: body.tools }),
          model,
          ...(maxTokens === undefined ? {} : { maxTokens }),
          isReasoning,
        },
        session.identity,
        {
          ...(known === undefined ? {} : { displayName: known.displayName }),
          ...(known?.maxInputTokens === undefined ? {} : { maxInputTokens: known.maxInputTokens }),
          ...(known?.maxOutputTokens === undefined ? {} : { defaultMaxTokens: known.maxOutputTokens }),
        },
      )
      try {
        const raw = await openQoderChatStream(session, requestBody, signal, attributionHeaders())
        if (raw.body === null) throw new QoderUpstreamError(502, 'empty upstream stream')
        void this.persist(account)
        return new Response(synthesizeOpenAiSse(parseSse(raw.body)), {
          headers: { 'content-type': 'text/event-stream' },
        })
      } catch (error) {
        lastError = error
        // A rejected credential is a fact about this account; drop its cached
        // session so the next attempt rebuilds from the stored token.
        this.sessions.delete(account.id)
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Qoder request failed')
  }
}

/**
 * The Qoder provider adapter. It owns request serialization because the pool
 * rotates accounts inside one turn and the wire body must be assembled from the
 * Harness vocabulary rather than sent as a generic OpenAI request.
 */
export class QoderAdapter extends LlmAdapter {
  constructor(private readonly client: QoderClient) { super() }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Qoder' }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const signedIn = await this.client.signedIn()
    // A signed-out pool still advertises the free route, marked unavailable, so
    // the model selector shows what signing in adds.
    //
    // Signed in, the whole directory is listed: the free flash route is what
    // this connector advertises, and a metered sibling is what a user may switch
    // on deliberately. Which of the two starts in the picker is the row's own
    // price (see `model-price.ts`), not its presence here.
    const models = signedIn ? await this.client.allModels() : [QODER_FALLBACK_MODEL]
    return models.map(model => ({
      provider,
      id: model.id,
      name: model.displayName,
      description: qoderModelDescription(model),
      inputModalities: ['text'] as const,
      ...signedIn
        ? { availability: 'available' as const }
        : { availability: 'unavailable' as const, unavailableReason: 'QODER_LOGIN_REQUIRED' },
    }))
  }

  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    // The whole directory, so a metered route the user switched on resolves to
    // its own context window and reasoning ladder instead of the fallback's.
    const known = (await this.client.allModels()).find(candidate => candidate.id === model)
    return {
      provider,
      id: model,
      name: known?.displayName ?? QODER_FALLBACK_MODEL.displayName,
      inputModalities: ['text'],
      context: { contextWindow: known?.contextWindow ?? QODER_DEFAULT_CONTEXT },
      defaultMaxTokens: known?.maxTokens ?? 16_384,
      // Offered on every route the connector serves rather than gated on the
      // directory's `is_reasoning`: that flag describes the product's own tile,
      // and the one route here emits reasoning while it reads false, so gating
      // on it would hide the control from the only model the user has.
      reasoning: {
        efforts: QODER_REASONING_EFFORTS.map(effort => ({
          id: ReasoningEffortId(effort),
          name: effort === 'off' ? 'Off' : 'On',
        })),
        defaultEffort: ReasoningEffortId(QODER_REASONING_DEFAULT),
      },
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const body = serializeRequest(options)
    let response: Response
    try {
      response = await this.client.chat(body, options.signal)
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError('Qoder request aborted by caller', 'ABORTED', { cause: error })
      throw qoderLlmError(error)
    }
    if (response.body === null) throw new LlmError('Qoder returned no response body', 'EMPTY_RESPONSE')
    try {
      yield* translate(parseSse(response.body))
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError('Qoder request aborted by caller', 'ABORTED', { cause: error })
      if (error instanceof LlmError) throw error
      throw qoderLlmError(error)
    }
  }
}
