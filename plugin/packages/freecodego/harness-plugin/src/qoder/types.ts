/**
 * Host-only types for the native Qoder connector.
 *
 * Qoder routes every API call through the `cosy` signed protocol (a per-account
 * session key plus a derived device fingerprint). Credentials and the derived
 * device identity are Host-only; the browser sees only the browser-safe rows in
 * `../types.ts`.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/qoder/types
 */

/** Qoder site region. */
export type QoderRegion = 'global' | 'cn'

/** The endpoint set one Qoder region addresses. */
export interface QoderEndpoints {
  /** OAuth device login page. */
  readonly deviceLoginBase: string
  /** deviceToken/poll endpoint. */
  readonly pollEndpoint: string
  /** `/api/v1/userinfo` identity lookup. */
  readonly userinfoBase: string
  /** `/api/v2/user/plan` plan lookup. */
  readonly planEndpoint: string
  /** `/api/v2/quota/usage` quota lookup. */
  readonly quotaEndpoint: string
  /** SSE chat stream. */
  readonly chatStreamUrl: string
  /** `/algo/api/v2/model/list` directory. */
  readonly modelListUrl: string
  /** PAT → job-token exchange. */
  readonly jobTokenUrl: string
  /**
   * Origin carrying the account's campaigns (`/sash/api/v1/me/...`).
   *
   * The daily credit campaign is read and claimed here. It answers to the plain
   * `Bearer` device token with `Cosy-ClientType: 10` and needs none of the cosy
   * device signature the chat endpoints require.
   *
   * The CN origin is the one confirmed against a working client; the global one
   * is the same service under the same path, which is an inference rather than an
   * observation. A refusal in the global region is therefore a path question
   * before it is an account question.
   */
  readonly campaignsBase: string
}

/** Remaining allowance of one Qoder quota bucket. */
export interface QoderQuotaBucket {
  readonly used: number
  readonly total: number
  readonly remaining: number
  readonly resetTime?: string
}

/** One account's Qoder quota snapshot. */
export interface QoderQuota {
  readonly plan?: string
  readonly userQuota?: QoderQuotaBucket
  readonly addonQuota?: QoderQuotaBucket
  readonly isQuotaExceeded: boolean
  readonly expiresAt?: number
  /** Epoch ms this snapshot was read. */
  readonly checkedAt: number
  /** Upstream's own reason when the query could not be answered. */
  readonly error?: string
}

/** The cosy auth identity carried in the session payload. */
export interface QoderIdentity {
  readonly name: string
  readonly aid: string
  readonly uid: string
  readonly organizationId?: string
  readonly organizationName?: string
  readonly userType: string
  readonly securityOauthToken: string
  readonly refreshToken?: string
}

/** A Qoder device/refresh token pair. */
export interface QoderTokenPair {
  readonly deviceToken: string
  readonly refreshToken?: string
}

/** One Qoder model as the upstream directory describes it. */
export interface QoderModel {
  readonly key: string
  readonly displayName: string
  readonly enable: boolean
  readonly isDefault: boolean
  readonly isReasoning: boolean
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
  readonly maxInputTokens?: number
  readonly priceFactor?: number
}

/** Host-only Qoder account row; the tokens never leave the Host vault. */
export interface QoderAccount {
  readonly id: string
  readonly region: QoderRegion
  readonly deviceToken: string
  readonly refreshToken?: string
  readonly uid?: string
  readonly name?: string
  readonly email?: string
  readonly userType?: string
  readonly plan?: string
  readonly organizationId?: string
  readonly organizationName?: string
  readonly createdAt: number
  readonly lastChecked: number
  readonly quota?: QoderQuota
  readonly quotaError?: string
}

/** A live Qoder cosy session plus the fingerprint it signs with. */
export interface QoderSession {
  readonly identity: QoderIdentity
  readonly tempKey: Buffer
  readonly cosyKey: string
  readonly info: string
  readonly machineId: string
  readonly machineToken: string
  readonly machineType: string
  readonly region: QoderRegion
}

/** One parsed delta out of the Qoder SSE envelope. */
export interface QoderDelta {
  readonly role?: string
  readonly content?: string
  readonly reasoning?: string
  readonly toolCalls?: readonly unknown[]
  readonly inputTokens?: number
  readonly outputTokens?: number
}
