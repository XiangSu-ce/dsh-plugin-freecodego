/** Validated non-secret third-party provider configuration. */

export type ThirdPartyProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages'

/**
 * One model a third-party route offers.
 */
export interface ThirdPartyModel {
  readonly id: string
  readonly displayName: string
  readonly contextWindow: number
  readonly outputLimit: number
  readonly tools: boolean
  readonly vision: boolean
}

/**
 * One user-configured third-party provider route.
 */
export interface ThirdPartyRoute {
  readonly id: string
  readonly displayName: string
  readonly protocol: ThirdPartyProtocol
  readonly baseUrl: string
  readonly credentialReference: string
  readonly headers: Readonly<Record<string, string>>
  readonly models: readonly ThirdPartyModel[]
  readonly timeoutMs: number
  readonly maxRetries: number
}

// Header names whose values must never ride along in non-secret route config.
// The match is suffix-oriented: `token`/`secret`/`key`/`password`/`credential`
// endings cover regional variants (`token`, `azure-api-key`), Cloudflare
// Access (`cf-access-token`), and bare JWT headers alike. Bare `auth`/
// `authentication` names are screened too: they are common carriers for
// pass-through bearer credentials and are never legitimate route config.
const SECRET_HEADER = /(?:^|[-_ ])(?:authorization|cookie|proxy[-_ ]?authorization|api[-_ ]?key|api[-_ ]?token|access[-_ ]?token|auth[-_ ]?token|refresh[-_ ]?token|session[-_ ]?token|bearer(?:[-_ ]?token)?|jwt)(?:$|[-_ ])|(?:^|[-_ ])(?:token|secret|password|credential|auth(?:entication)?|private[-_ ]?key)(?:$|[-_ ])/i

/** Reject unsafe endpoint/secret settings before a route is registered. 
 * @returns the third Party Route.
 * @param route - the route settings to screen.
 * @param allowInsecureLocalhost - permits plain HTTP when the endpoint is on localhost.
 */
export function validateThirdPartyRoute(route: ThirdPartyRoute, allowInsecureLocalhost = false): ThirdPartyRoute {
  if (!/^[a-z][a-z0-9-]{1,63}$/i.test(route.id)) throw new Error('third-party provider id is invalid')
  if (route.displayName.trim() === '') throw new Error('third-party display name is required')
  if (!['openai-chat', 'openai-responses', 'anthropic-messages'].includes(route.protocol)) throw new Error('third-party protocol is unsupported')
  const url = new URL(route.baseUrl)
  // Credentials embedded in the URL itself (`https://user:pass@host`) would
  // ride along as "non-secret" configuration; strip them from validation and
  // reject the route so the operator re-enters them via credentials.
  if (url.username !== '' || url.password !== '') throw new Error('third-party base URL must not embed credentials; use the credential reference')
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(allowInsecureLocalhost && local && url.protocol === 'http:')) throw new Error('third-party base URL must use HTTPS')
  if (route.credentialReference.trim() === '') throw new Error('third-party credential reference is required')
  if (!Number.isSafeInteger(route.timeoutMs) || route.timeoutMs < 1 || route.timeoutMs > 300_000) throw new Error('third-party timeout must be between 1 and 300000ms')
  if (!Number.isSafeInteger(route.maxRetries) || route.maxRetries < 0 || route.maxRetries > 10) throw new Error('third-party max retries must be between 0 and 10')
  for (const [name, value] of Object.entries(route.headers)) {
    if (SECRET_HEADER.test(name)) throw new Error(`third-party header "${name}" must be stored through credentials`)
    if (value.includes('\r') || value.includes('\n')) throw new Error(`third-party header "${name}" is invalid`)
  }
  if (route.models.length === 0) throw new Error('third-party route requires at least one model')
  for (const model of route.models) {
    if (model.id.trim() === '' || model.displayName.trim() === '') throw new Error('third-party model id and display name are required')
    if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1 || !Number.isSafeInteger(model.outputLimit) || model.outputLimit < 1) throw new Error(`third-party model "${model.id}" limits are invalid`)
  }
  return route
}
