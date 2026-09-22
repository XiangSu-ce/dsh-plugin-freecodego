/**
 * Host-only types for the native TRAE (SOLO) connector.
 *
 * A TRAE session is a pair of tokens plus the machine identity that authorized
 * them. All four are Host-only: the browser sees the account's name and id, and
 * nothing that could be replayed against the upstream.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/trae/types
 */

import type { TraeRealm } from './realms.ts'

/**
 * The fields one SOLO sign-in redirect carries.
 *
 * The redirect is the only place the refresh token exists in the clear, which
 * is why it is parsed once, exchanged immediately, and never stored as parsed.
 */
export interface TraeCallbackInfo {
  /** The refresh token to exchange; absent only on the degraded `userJwt` path. */
  readonly refreshToken?: string
  /** An access token the redirect carried directly, when no refresh token did. */
  readonly accessToken?: string
  /** The account's uid, from the redirect's `userInfo`. */
  readonly uid: string
  /** The account's display name, repaired from the redirect's encoding. */
  readonly nickname?: string
  /** The enterprise (tenant) id, when the account belongs to one. */
  readonly enterpriseId?: string
  /**
   * The account's own region code, when the redirect states one (`SG`, `US`).
   *
   * Absent is a normal answer — the China redirect has never carried one — and an
   * account that states none is served by its realm's default host.
   */
  readonly userRegion?: string
  /** Expiry of {@link accessToken}, in Unix seconds; `0` when unknown. */
  readonly expiresAt: number
}

/** One rotated token triple, as `ExchangeToken` answers it. */
export interface TraeToken {
  readonly accessToken: string
  /** The rotated refresh token: the one just used is spent. */
  readonly refreshToken: string
  /** Access-token expiry in Unix seconds; `0` when the upstream stated none. */
  readonly expiresAt: number
}

/** An in-flight browser authorization, as the Host holds it. */
export interface TraeLoginAttempt {
  /** The opaque id the settings card polls. */
  readonly state: string
  /** The deployment this attempt authorizes against. */
  readonly realm: TraeRealm
  /** The URL the browser must be opened on. */
  readonly loginUrl: string
  /** The machine identity the issued session will belong to. */
  readonly machineId: string
  readonly deviceId: string
  /** The loopback URL this attempt is listening on. */
  readonly callbackUrl: string
  /** Epoch ms after which the attempt is abandoned. */
  readonly expiresAt: number
}

/**
 * One host-only TRAE account.
 *
 * `accessToken` is a cache, not a source of truth: it is rotated from
 * `refreshToken` and written back. Losing it costs one exchange; losing the
 * refresh token costs a sign-in, which is why the invalidation rule lives in
 * `trae-intl.ts` and only for a credential the upstream actually rejected.
 */
export interface TraeAccount {
  /** Stable local id, derived from the uid. */
  readonly id: string
  /**
   * Which deployment this account belongs to.
   *
   * Part of the account rather than of the process: the same Host holds China and
   * international accounts at once, and their chat hosts, token hosts, client ids
   * and model catalogs are all different. A row stored before realms existed has
   * no field and reads as China — see `realms.traeRealmOf`.
   */
  readonly realm: TraeRealm
  /**
   * The account's own region code, when the sign-in stated one (`SG`, `US`).
   *
   * The international deployment splits its chat traffic on it: a `US` account is
   * served by a different chat host than an `SG` one, on the same auth host.
   */
  readonly userRegion?: string
  readonly uid: string
  readonly nickname: string
  readonly enterpriseId?: string
  /** The machine the authorization was issued to. */
  readonly machineId: string
  readonly deviceId: string
  readonly accessToken: string
  readonly refreshToken: string
  /** Access-token expiry in Unix seconds. */
  readonly expiresAt: number
  readonly createdAt: number
  readonly lastChecked: number
}

/** One configuration (model) the SOLO channel offers. */
export interface TraeModel {
  /** The `config_name` the conversation body must carry. */
  readonly id: string
  readonly displayName: string
  /**
   * Whether a picker may offer this configuration.
   *
   * Decided while the upstream row is in hand, because the answer is in fields
   * this type does not keep — the visibility flag, the BYOK slot list, and
   * whether the table named the row at all. Parsing keeps every row and records
   * the verdict here, so routing can still recognize a configuration a stored
   * session names while the picker hides it (see `selectableTraeModels`).
   */
  readonly selectable: boolean
}
