/**
 * The TRAE (SOLO) endpoints this connector addresses, the paths it reaches them
 * on, and the timing constants of its sign-in.
 *
 * Both deployments are served, and each is three hosts rather than one: a console
 * that issues the browser authorization, an auth host that exchanges the refresh
 * token it hands back, and a chat host that carries the conversation. Which host
 * serves which role is per realm and lives in `./realms.ts`; this module only
 * turns that table into URLs. The constants under the China names below are the
 * realm table's China column, kept as names because they are what the check-in and
 * the sign-in tests address.
 *
 * The declared IDE build is not cosmetic. The upstream unlocks model
 * configurations by the declared build *and product identity*: a request that
 * names a model the declared build predates answers `4001 param is invalid` even
 * though the model exists, and the same account reads a 13-model table as one
 * product and a truncated one as another. That is why the build string is a
 * per-realm field, and why it is part of the routing data rather than a version
 * nobody checks.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/trae/endpoints
 */

import { traeChatHost, traeIdeVersionCode, traeRealmConfig } from './realms.ts'
import type { TraeRealm } from './realms.ts'

/** Conversation host of the China realm: `/api/agent/v3/llm_utils_chat`, `/api/ide/v1/get_detail_param`. */
export const TRAE_AGENT_HOST = traeRealmConfig('cn').chatHost
/** The China SOLO browser sign-in page. */
export const TRAE_CONSOLE_HOST = traeRealmConfig('cn').consoleHost
/** The China token host: `/cloudide/api/v3/trae/oauth/ExchangeToken`. */
export const TRAE_OAUTH_HOST = traeRealmConfig('cn').authHost

/**
 * The public OAuth client id the China SOLO sign-in registers the flow under.
 *
 * The international deployment registers under a different one, and a token is
 * matched to the client that asked for it: the wrong id answers `10101 refresh
 * token is not matched to the client`, which reads as a broken credential.
 */
export const TRAE_CLIENT_ID = traeRealmConfig('cn').oauthClientId

/** The China IDE build every China request declares. */
export const TRAE_IDE_VERSION = traeRealmConfig('cn').ideVersion
/** The China build's release stamp, sent beside {@link TRAE_IDE_VERSION}. */
export const TRAE_IDE_VERSION_CODE = traeIdeVersionCode('cn')

/**
 * The one upstream entry point this connector is allowed to reach.
 *
 * TRAE advertises several conversation functions (`work`, `solo`, `work_lite`);
 * only `solo_work_lite` is served to a non-IDE caller, and it is billed against
 * the account's `ide_credits`. The value is a protocol constant, not a setting.
 */
export const TRAE_FUNCTION = 'solo_work_lite'

/**
 * The desktop client identity every SOLO request declares.
 *
 * These are the values of the official client's own session, not this machine's
 * platform: the upstream reads them as the build that authorized the token, and
 * a request that claims a different device than the one in the callback is not
 * the session the user approved. They are constants for that reason — reporting
 * the Host's real platform here is untested against the upstream and would
 * change what the authorization is bound to.
 */
export const TRAE_APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8'
/** The declared application version (`default` for the stable build). */
export const TRAE_APP_VERSION = 'default'
/** The declared device class. */
export const TRAE_DEVICE_TYPE = 'windows'
/** The declared OS string. */
export const TRAE_OS_VERSION = 'Windows 11 Pro'
/** The declared device brand. */
export const TRAE_DEVICE_BRAND = '83DG'

/**
 * The conversation URL one account's turn is sent to.
 * @param realm - the account's realm.
 * @param userRegion - the account's region code, which the international deployment splits on.
 * @returns the chat endpoint.
 */
export function traeChatUrl(realm: TraeRealm, userRegion?: string): string {
  return `${traeChatHost(realm, userRegion)}${TRAE_CHAT_PATH}`
}

/**
 * The configuration-table URL one account's realm serves.
 * @param realm - the account's realm.
 * @param userRegion - the account's region code.
 * @returns the directory endpoint.
 */
export function traeModelsUrl(realm: TraeRealm, userRegion?: string): string {
  return `${traeChatHost(realm, userRegion)}${TRAE_MODELS_PATH}`
}

/**
 * The token-exchange URLs to try, in order.
 *
 * The first entry is the realm's own auth host; the rest are hosts the same
 * service has been observed on. A refusal from the first is only retried on the
 * next when it looks like a wrong host (404, or a gateway page that is not JSON),
 * because a credential refusal repeats identically on every host.
 * @param realm - the realm whose token is being exchanged.
 * @returns the candidate hosts.
 */
export function traeExchangeHosts(realm: TraeRealm): readonly string[] {
  const config = traeRealmConfig(realm)
  return [config.authHost, ...(config.authHostFallbacks ?? [])]
}

/** Path of the SOLO conversation stream. */
export const TRAE_CHAT_PATH = '/api/agent/v3/llm_utils_chat'
/** Path of the configuration (model) table. */
export const TRAE_MODELS_PATH = '/api/ide/v1/get_detail_param'
/** Path that rotates a refresh token into an access token. */
export const TRAE_EXCHANGE_PATH = '/cloudide/api/v3/trae/oauth/ExchangeToken'
/** The sign-in page path the browser is sent to. */
export const TRAE_AUTHORIZE_PATH = '/authorization'

/** How long one browser authorization stays answerable. */
export const TRAE_LOGIN_STATE_TTL_MS = 10 * 60_000
/** Interval between the settings card's polls of one authorization. */
export const TRAE_LOGIN_POLL_INTERVAL_MS = 1_500
/** How long a stowed configuration table is reused before it is read again. */
export const TRAE_MODELS_CACHE_TTL_MS = 10 * 60_000
/**
 * How long the configuration-table read may take.
 *
 * The read is a single POST that measures ~215 ms against both deployments, so
 * the ceiling is a guard against a stalled socket rather than a budget: whoever
 * waits on it is a picker the user has already opened.
 */
export const TRAE_DIRECTORY_TIMEOUT_MS = 20_000
/**
 * The same ceiling for a caller that is only *listing* models.
 *
 * A listing nobody is waiting on can afford the full timeout; a list the picker
 * is blocked on cannot, and a route that has not answered in this long is not
 * going to populate a menu the user is staring at. Measured on this deployment the
 * read answers in ~215 ms, and the whole model catalog the menu opens with takes
 * ~5.5 s when its caches are cold — every provider is built in parallel and the
 * slowest one sets that number, so three seconds is already an outlier twice over.
 */
export const TRAE_DIRECTORY_LIST_TIMEOUT_MS = 3_000
/**
 * How long a failed background refresh waits before it is tried again.
 *
 * Without it, a stale list plus an unreachable upstream means every picker render
 * starts another failing read; with it, the stale list holds and the retry is quiet.
 */
export const TRAE_MODELS_REFRESH_BACKOFF_MS = 60_000
/** How long before expiry a token is rotated. */
export const TRAE_TOKEN_REFRESH_SKEW_MS = 5 * 60_000

/**
 * The daily-credit host.
 *
 * A different origin from the conversation host: the check-in lives on the
 * account API (`api.trae.cn`), which is also where the IDE itself claims its
 * daily credits, while turns go to the SOLO conversation host.
 */
export const TRAE_CREDITS_HOST = 'https://api.trae.cn'
/** `checkin_credits/status`: today's state of the check-in campaign. */
export const TRAE_CHECKIN_STATUS_PATH = '/trae/api/v2/ug/checkin_credits/status'
/** `checkin_credits/claim`: the claim itself. */
export const TRAE_CHECKIN_CLAIM_PATH = '/trae/api/v2/ug/checkin_credits/claim'
export const TRAE_CHECKIN_STATUS_URL = `${TRAE_CREDITS_HOST}${TRAE_CHECKIN_STATUS_PATH}`
export const TRAE_CHECKIN_CLAIM_URL = `${TRAE_CREDITS_HOST}${TRAE_CHECKIN_CLAIM_PATH}`
/**
 * The body every check-in call carries.
 *
 * `req_source: 1` is the IDE's own value, confirmed against a working client;
 * the claim answers `9074` for other values, which reads as risk control and
 * costs a retry every time.
 */
export const TRAE_CHECKIN_BODY = { req_source: 1 } as const
/**
 * The region header the claim endpoint requires.
 *
 * Without it upstream answers `9074` (risk control) rather than claiming, which
 * is why this connector's own region is stated on every call instead of relying
 * on the token to imply it. The check-in is a China-service feature (see
 * `realms.ts`), so one region is the honest answer here.
 */
export const TRAE_USER_REGION = 'CN'
/**
 * How long to wait before the next attempt, per retry.
 *
 * Short steps, and the reason is the fix rather than the wait: `9074` is a
 * refusal of the *device*, so each attempt presents a new device number and the
 * pause only has to keep the retries from arriving in one burst. The reference
 * script that rotates devices pauses 0.8–1.5s between them; the ladder that
 * waited 2/5/10s was built on the theory that the throttle clears on its own.
 * One entry per retry, so the attempt count is this length plus one.
 */
export const TRAE_CHECKIN_RETRY_DELAYS_MS = [1_000, 1_500, 2_000, 2_500] as const

/** The China conversation URL, kept for the tests and probes that address it directly. */
export const TRAE_CHAT_URL = traeChatUrl('cn')
/** The China configuration-table URL, for the same reason. */
export const TRAE_MODELS_URL = traeModelsUrl('cn')

/** The path the sign-in page redirects to once the browser authorizes. */
export const TRAE_CALLBACK_PATH = '/authorize'

/** The plugin build the sign-in page records; part of the request's identity. */
const TRAE_PLUGIN_VERSION = '2.3.62834'

/**
 * The loopback address the sign-in page redirects to.
 *
 * Loopback rather than a public callback because the Host runs on the machine
 * the browser is on, and the redirect carries the refresh token: a public
 * endpoint would hand a credential to whoever answers it. The port is chosen
 * per attempt (`0` lets the OS pick) so two attempts cannot collide.
 * @param port - the port the Host's callback listener took.
 * @returns the callback URL the login URL must carry.
 */
export function traeCallbackUrl(port: number): string {
  return `http://127.0.0.1:${port}${TRAE_CALLBACK_PATH}`
}

/**
 * The machine identity one login attempt claims.
 *
 * The values are random per attempt and must be the ones the issued token is
 * used with: the conversation endpoint reads `X-Machine-Id`/`X-Device-Id`, and
 * a session presented under a different device than the one that authorized it
 * is not the session the user approved.
 */
export interface TraeMachineIdentity {
  /** 32 hex characters, as the sign-in page expects. */
  readonly machineId: string
  /** 32 hex characters, as the sign-in page expects. */
  readonly deviceId: string
}

/**
 * The stable `login_trace_id` for one machine identity.
 *
 * The sign-in page wants a 16-hex-character trace id that does not change
 * between the URL it receives and the callback it produces. Deriving it from
 * the machine identity keeps that property without stowing a third value.
 * @param identity - the attempt's machine identity.
 * @returns the trace id.
 */
export function traeLoginTraceId(identity: TraeMachineIdentity): string {
  const joined = identity.machineId + identity.deviceId
  return joined.length >= 16 ? joined.slice(-16) : '0'.repeat(16 - joined.length) + joined
}

/**
 * Build the SOLO authorization URL the browser is opened on.
 *
 * Every parameter is the protocol's; the ones worth reading twice are
 * `auth_callback_url`, which is where the refresh token is handed to *this*
 * machine, and the version fields, which the page echoes back into the issued
 * session.
 * @param identity - the attempt's machine identity.
 * @param callbackUrl - the loopback URL the Host is listening on.
 * @returns the URL to open.
 */
export function buildTraeLoginUrl(identity: TraeMachineIdentity, callbackUrl: string, realm: TraeRealm = 'cn'): string {
  const config = traeRealmConfig(realm)
  const params = new URLSearchParams({
    login_version: '1',
    auth_from: 'solo',
    login_channel: 'native_ide',
    plugin_version: TRAE_PLUGIN_VERSION,
    auth_type: 'local',
    // The console and the client id travel together: a page that does not know the
    // client id it is authorizing issues a token no exchange can use.
    client_id: config.oauthClientId,
    redirect: '0',
    login_trace_id: traeLoginTraceId(identity),
    auth_callback_url: callbackUrl,
    machine_id: identity.machineId,
    device_id: identity.deviceId,
    x_device_id: identity.deviceId,
    x_machine_id: identity.machineId,
    x_device_brand: 'PC',
    x_device_type: 'PC',
    x_os_version: '1.0',
    x_app_version: config.ideVersion,
    x_app_type: 'stable',
  })
  return `${config.consoleHost}${TRAE_AUTHORIZE_PATH}?${params.toString()}`
}
