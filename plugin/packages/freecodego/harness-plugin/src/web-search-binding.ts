/**
 * Keeping a saved web-search binding alive across a restart.
 *
 * The stock web-search page's namespace can name an endpoint, a key, and a model,
 * but not which of this plugin's routes that endpoint stands for. For a provider
 * with its own Anthropic API that does not matter: the URL is the same tomorrow.
 * For every other provider it does — the binding the page holds is a route of the
 * local bridge, and the bridge mints its port, its route ids, and its secret per
 * process. A restart therefore leaves the page configured with an endpoint nothing
 * answers, and the failure a user sees is a connection error they cannot attribute
 * to the choice they made before the restart.
 *
 * Two passes cover that, and both ask the same question of the same classifier:
 *
 * - {@link repairWebSearchBinding} runs once at process start, so a search works
 *   before any browser has opened.
 * - {@link webSearchBindingStatus} answers the page, which repairs the binding
 *   itself when the boot pass could not — a Host without the credentials service
 *   mounted cannot write the key, and the client can.
 *
 * Three rules keep them from doing harm:
 *
 * - **They own only the binding this plugin wrote.** A section is touched only when
 *   it names this plugin's credential reference *and* an endpoint whose route this
 *   process minted. A user's own DeepSeek key, endpoint, or model is never rewritten
 *   by something that runs at boot.
 * - **They never guess the pair.** The provider and model come from this plugin's own
 *   settings, where the page records them when it writes a binding. A binding from
 *   before that record existed is reported instead of rebuilt, and the page is where
 *   the user re-picks it.
 * - **Nothing process-local is treated as permanent.** An endpoint that is not a
 *   bridge route is reported as durable, not "alive for now": whether it answers is
 *   that provider's business, and the page shows its own failures for it.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/web-search-binding
 */

import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { bridgeRouteIdOf } from './claude-protocol-bridge.ts'
import { asString } from './untrusted-json.ts'
import type { FreeCodeGoWebSearchBinding, FreeCodeGoWebSearchBindingStatus } from './types.ts'

/**
 * Credential reference this plugin's web-search binding writes its key under.
 *
 * Its own reference, never the provider's default: the search provider resolves
 * `apiKeyEnv` for every search, so writing our bridge key over `DEEPSEEK_API_KEY`
 * would replace a key the user typed for the official endpoint — and every official
 * route would then fail with an authentication error nobody could attribute to the
 * search page. It is a `CredentialRef` rather than a bare string because the repair
 * pass writes it back, and that write goes through the credentials domain.
 */
export const WEB_SEARCH_API_KEY_REF: CredentialRef = credentialRef('FREECODEGO_WEB_SEARCH_API_KEY')

/**
 * The stock web-search page's settings entry.
 *
 * Spelled as the page spells it. The page owns the namespace; this plugin only
 * needs to address the same one, and importing it from the provider would make a
 * client-visible package a Host dependency.
 */
export const WEB_SEARCH_SETTINGS_NAMESPACE = 'web-search-deepseek'

/** The section a pass reads, as an untrusted record. */
export type WebSearchStoredSection = Readonly<Record<string, unknown>>

/** What one pass concluded about the saved binding. */
export type WebSearchBindingOutcome =
  /** The saved binding still answers — a bridge route this process serves, or a durable endpoint; nothing was written. */
  | 'live'
  /** The saved binding was dead and has been rebuilt from the remembered pair. */
  | 'rebuilt'
  /** The section names this plugin's binding, but no pair was recorded to rebuild it with. */
  | 'no-memory'
  /** The section holds someone else's binding — the user's own key for the official endpoint, or a namespace this plugin never wrote. */
  | 'not-applicable'
  /** The namespace is not served by this Host, so no page is holding a stale endpoint. */
  | 'unavailable'
  /** Resolution or the write itself failed; `detail` carries the reason. */
  | 'failed'

/** What the repair pass reports back to the caller's log. */
export interface WebSearchBindingReport {
  readonly outcome: WebSearchBindingOutcome
  /** The failure's own message, present only when `outcome` is `failed`. */
  readonly detail?: string
}

/**
 * The reads and the bridge question both passes share.
 *
 * One shape, so a Host wires them once and the two answers cannot come from different
 * sources: the repair deciding "dead, rebuild it" while the page read "alive, leave
 * it" is exactly the disagreement this file exists to prevent.
 */
export interface WebSearchBindingReads {
  /** Read the current section, or undefined when the namespace is not served. */
  readonly readSection: () => Promise<WebSearchStoredSection | undefined>
  /** Whether this process still serves a bridge route id. */
  readonly servesBridgeRoute: (routeId: string) => boolean
  /** The pair the page recorded when it wrote the binding, or nothing. */
  readonly remembered: { readonly provider: string; readonly model: string } | undefined
}

/** Everything a repair pass reads and writes, injected so the rules are testable. */
export interface WebSearchBindingRepairDeps extends WebSearchBindingReads {
  /** Resolve one of this plugin's routes the way a fresh pick would. */
  readonly bind: (input: { readonly provider: string; readonly model: string }) => Promise<FreeCodeGoWebSearchBinding>
  /** Write the key the rewritten section will name. */
  readonly writeCredential: (ref: string, value: string) => Promise<void>
  /** Rewrite the section's three fields. */
  readonly writeSection: (patch: { readonly model: string; readonly baseURL: string; readonly apiKeyEnv: string }) => Promise<void>
}

/** The reads a status answer needs: the shared reads, and nothing to write. */
export type WebSearchBindingStatusDeps = WebSearchBindingReads

/** An error's own message, for a log line the operator can act on. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * What a saved section is, as both passes read it.
 *
 * The classifier is shared rather than repeated because the two answers must agree:
 * a page that reads "durable, leave it alone" while the boot pass read "bridge,
 * rebuild it" would rewrite a section the user just edited by hand.
 * @param section - the section as stored, or undefined when the namespace is not served.
 * @param servesBridgeRoute - the bridge's own answer for a route id.
 * @returns the status this plugin reports for the saved binding.
 */
function classify(
  section: WebSearchStoredSection | undefined,
  servesBridgeRoute: (routeId: string) => boolean,
): FreeCodeGoWebSearchBindingStatus {
  if (section === undefined) return { state: 'none', alive: true }
  // The reference is this plugin's own and nothing else writes it, so a section that
  // names it was written by the page here — a missing or different one is the user's
  // own key for the official endpoint, which no pass in this file may touch.
  if (asString(section.apiKeyEnv) !== WEB_SEARCH_API_KEY_REF) return { state: 'other', alive: true }
  const saved = asString(section.baseURL)
  // Our reference with no endpoint at all is not a binding this plugin can place on a
  // route: there is nothing to compare, and writing one would replace whatever the page
  // was in the middle of. It stays the page's to show and to save.
  if (saved === undefined) return { state: 'other', alive: true }
  const routeId = bridgeRouteIdOf(saved)
  // Our reference with an endpoint that is not a bridge route is a provider serving
  // its own API: same URL tomorrow, so nothing here can expire. Reporting it `durable`
  // rather than "alive for now" is what keeps a restart from offering to re-pick a
  // choice that never needed re-picking.
  return routeId === undefined
    ? { state: 'durable', alive: true }
    : { state: 'bridge', alive: servesBridgeRoute(routeId) }
}

/**
 * Report what the saved web-search binding is, and whether it still answers.
 *
 * The page asks this instead of comparing endpoints itself, because a fresh
 * `webSearchBind` mints a *new* route id every time: "the saved URL equals a freshly
 * resolved one" is false for every healthy bridge binding, so the comparison could
 * only ever report a stale one. Liveness is a question for the bridge that minted the
 * route, and this is where it is asked.
 *
 * @param deps - the section read, the bridge's route table, and the remembered pair.
 * @returns the status the page renders from.
 */
export async function webSearchBindingStatus(deps: WebSearchBindingStatusDeps): Promise<FreeCodeGoWebSearchBindingStatus> {
  const section = await deps.readSection()
  const status = classify(section, deps.servesBridgeRoute)
  return deps.remembered === undefined ? status : { ...status, remembered: deps.remembered }
}

/**
 * Rebuild the web-search binding this plugin owns, if this process cannot serve it.
 *
 * The credential is written before the section that names it: a section pointing at
 * a reference that holds nothing turns every search into an authentication failure,
 * which is the opposite of a repair. A failed resolution leaves the section exactly
 * as it was, so the page keeps showing what the user chose and can offer the pick
 * again rather than reporting a setting that silently disappeared.
 *
 * @param deps - the reads, the bridge question, and the writes.
 * @returns what the pass concluded.
 */
export async function repairWebSearchBinding(deps: WebSearchBindingRepairDeps): Promise<WebSearchBindingReport> {
  let section: WebSearchStoredSection | undefined
  try {
    section = await deps.readSection()
  } catch (error) {
    return { outcome: 'failed', detail: messageOf(error) }
  }
  const status = classify(section, deps.servesBridgeRoute)
  if (status.state === 'none') return { outcome: 'unavailable' }
  if (status.state === 'other') return { outcome: 'not-applicable' }
  // A durable endpoint outlives the process, and a live bridge route is this
  // process's own: neither has anything for a boot pass to fix.
  if (status.alive) return { outcome: 'live' }
  const remembered = deps.remembered
  if (remembered === undefined) return { outcome: 'no-memory' }
  try {
    const binding = await deps.bind(remembered)
    await deps.writeCredential(binding.apiKeyEnv, binding.apiKey)
    await deps.writeSection({ model: binding.model, baseURL: binding.baseURL, apiKeyEnv: binding.apiKeyEnv })
    return { outcome: 'rebuilt' }
  } catch (error) {
    return { outcome: 'failed', detail: messageOf(error) }
  }
}
