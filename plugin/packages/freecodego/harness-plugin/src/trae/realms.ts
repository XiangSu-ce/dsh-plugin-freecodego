/**
 * The two TRAE deployments ("realms") and everything that differs between them.
 *
 * Why a table
 * -----------
 * Trae runs a mainland-China service and an international (Singapore / US) one,
 * and they differ in far more than a base URL: the chat host, the host that issues
 * and rotates tokens, the sign-in console, the OAuth client id, the product
 * identity sent in headers, and the model catalog are all per-realm — and the two
 * catalogs are almost disjoint (47 names with 3 in common). Getting a single one of
 * those wrong fails in a way that names the wrong cause: a token sent to the other
 * realm's host answers `10101 refresh token is not matched to the client`, and a
 * model the other realm owns answers `4001 param is invalid` — neither mentions
 * regions. Spreading `if (realm === 'cn')` through four modules is how those
 * mistakes get made once per module, so the differences live here and each one is
 * auditable in one screen.
 *
 * Provenance
 * ----------
 * Everything CN-side is the set this connector has been sending since the SOLO
 * channel was added. Everything SG-side is measured from the international
 * clients by the reference implementation (`trae2api-main`, `docs/PROTOCOL.md`,
 * observed 2026-09-17) except where a field is marked inferred below — those have
 * no observation behind them yet and are the first thing to check if an
 * international sign-in misbehaves.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/trae/realms
 */

/** The deployments this connector can hold accounts for. */
export type TraeRealm = 'cn' | 'sg'

/**
 * One realm's endpoints and product identity.
 *
 * `productId`/`ideVersion` are not cosmetic: the configuration table a request can
 * see is chosen by the product identity, so the same international account reads a
 * 13-model catalog as SOLO and a catalog whose newer entries are all `4001` as the
 * classic client. `ideVersion` is therefore part of the routing data, not a
 * version string nobody checks.
 */
export interface TraeRealmConfig {
  readonly id: TraeRealm
  readonly label: { readonly zh: string; readonly en: string }
  /** Where conversation, directory and check-in traffic goes (US accounts differ, see {@link traeChatHost}). */
  readonly chatHost: string
  /**
   * The chat host a `userRegion: 'US'` account is served by.
   *
   * The same international product, a different chat deployment; auth still goes
   * through the international auth host.
   */
  readonly usChatHost?: string
  /** The host that exchanges and rotates tokens. Never the chat host: mixing them answers 404 TLB pages. */
  readonly authHost: string
  /**
   * Alternative token hosts to try when {@link authHost} refuses the exchange.
   *
   * Both China hosts below have been observed serving `ExchangeToken`, and which
   * one answers has changed with deployments: `api.trae.com.cn` is the host the
   * browser sign-in flow was measured on, `api.trae.cn` the one the newest
   * desktop-client study reports (and the host the check-in already uses). The
   * first is tried first because it is the one this connector has been signing in
   * through. The order is a preference, not a fallback chain for auth failures:
   * only a wrong-host refusal moves to the next one — a 404, or a 200 that is a
   * gateway page rather than JSON — because the same refusal twice would otherwise
   * look like a credential problem.
   */
  readonly authHostFallbacks?: readonly string[]
  /** The console that hosts the browser sign-in page. */
  readonly consoleHost: string
  /** OAuth client id. A mismatch answers `10101 refresh token is not matched to the client`. */
  readonly oauthClientId: string
  /**
   * SOLO product identity sent as `x-ide-version` and as the `user-agent` version.
   *
   * Not cosmetic: the declared build is part of the identity the configuration
   * table is chosen by, and a build that predates a model answers `4001` for it
   * even though the model exists (measured on China: `0.1.43` refused `glm-5.3`,
   * `0.1.52` served it).
   */
  readonly ideVersion: string
  /** Whether the daily credit check-in is implemented for this realm. */
  readonly creditCheckin: boolean
}

const REALMS: Readonly<Record<TraeRealm, TraeRealmConfig>> = {
  cn: {
    id: 'cn',
    label: { zh: '国内版', en: 'China' },
    chatHost: 'https://trae-api-cn.mchost.guru',
    authHost: 'https://api.trae.com.cn',
    authHostFallbacks: ['https://api.trae.cn'],
    consoleHost: 'https://www.trae.cn',
    oauthClientId: 'en1oxy7wnw8j9n',
    ideVersion: '0.1.52',
    creditCheckin: true,
  },
  sg: {
    id: 'sg',
    label: { zh: '国际版', en: 'Global' },
    chatHost: 'https://coresg-normal.trae.ai',
    usChatHost: 'https://coreva-normal.trae.ai',
    authHost: 'https://growsg-normal.trae.ai',
    // Inferred: the international console is `trae.ai`, and the sign-in page path
    // and parameters are the SOLO protocol's, which do not differ by realm.
    consoleHost: 'https://www.trae.ai',
    oauthClientId: 'ono9krqynydwx5',
    // Unverified, and the first field to question if an international sign-in
    // answers `4001`/`4023` for every model: a member of the same `0.1.x` family
    // the China SOLO client declares rather than a measurement. The reference
    // implementation reads this from the installed client's manifest, which this
    // Host has no copy of.
    ideVersion: '0.1.65',
    // Unmeasured: the daily credit campaign has only been seen on the China
    // service. Reporting "not available" is honest; sending an international token
    // to the China host would collect a 401 and be reported as a failed sign-in.
    creditCheckin: false,
  },
}

/** Every realm, in the order the settings card lists them. */
export const TRAE_REALMS: readonly TraeRealm[] = ['cn', 'sg']

/**
 * The realm a value names, or `undefined` when it names none.
 *
 * Accepts the spellings the upstream and the clients use (`solo`, `intl`, `global`,
 * `china`) so a stored credential or a caller's string never has to be translated
 * by hand at the call site.
 * @param value - the untrusted realm value.
 * @returns the realm, or `undefined`.
 */
export function normalizeTraeRealm(value: unknown): TraeRealm | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'cn' || normalized === 'solo' || normalized === 'solo-cn' || normalized === 'china') return 'cn'
  if (normalized === 'sg' || normalized === 'intl' || normalized === 'global' || normalized === 'international') return 'sg'
  return undefined
}

/**
 * One realm's configuration.
 * @param realm - the realm to describe.
 * @returns its configuration.
 */
export function traeRealmConfig(realm: TraeRealm): TraeRealmConfig {
  return REALMS[realm]
}

/**
 * The realm a stored account belongs to.
 *
 * Absent means China, and that default is deliberate rather than lazy: every
 * account this connector stored before realms existed was one, and the
 * alternative — treating an unlabelled row as international — would send those
 * tokens to a host that refuses them. The reference implementation shipped the
 * mirror-image bug (international accounts labelled China, so their rotation
 * always failed) and documents it, which is why this direction is worth stating.
 * @param value - the stored row's realm field.
 * @returns the realm to route this account with.
 */
export function traeRealmOf(value: unknown): TraeRealm {
  return normalizeTraeRealm(value) ?? 'cn'
}

/**
 * The chat host for one realm, honouring the international deployment's regional split.
 * @param realm - the account's realm.
 * @param userRegion - the account's own region code, when it stated one.
 * @returns the chat host to send this account's traffic to.
 */
export function traeChatHost(realm: TraeRealm, userRegion?: string): string {
  const config = traeRealmConfig(realm)
  const code = (userRegion ?? '').trim().toUpperCase()
  if (code === 'US' && config.usChatHost !== undefined) return config.usChatHost
  return config.chatHost
}

/**
 * The `x-ide-version-code` one realm's client sends.
 *
 * The SOLO client sends a build *date*, and the international client's own value
 * has only ever been observed as a date-derived number, so the international realm
 * derives it from today. China keeps this connector's constant: it is the value
 * its requests have been sent with, and replacing a working constant with a
 * derived one is a change no observation asks for.
 * @param realm - the account's realm.
 * @param now - current epoch ms.
 * @returns the version code header value.
 */
export function traeIdeVersionCode(realm: TraeRealm, now = Date.now()): string {
  if (realm === 'cn') return '20260811'
  const date = new Date(now)
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${date.getUTCFullYear()}${month}${day}`
}
