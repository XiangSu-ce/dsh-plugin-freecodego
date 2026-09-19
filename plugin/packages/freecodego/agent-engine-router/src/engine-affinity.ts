import type { AgentOptions } from '@deepseek-ai/dsh-agent'

export type AgentEngineId = 'deepseek' | 'codex' | 'claude'
export interface FreeCodeGoAgentOptions {
  readonly freeCodeGoEngine?: AgentEngineId
}

export type RoutedAgentOptions = AgentOptions & FreeCodeGoAgentOptions & {
  readonly engine?: string
  readonly provider?: string
  readonly model?: string
}

/**
 * Options carrying the durable engine marker, inside or outside the router.
 *
 * The marker is the router's own bookkeeping: it writes `engine` onto what it
 * routes ({@link RoutedAgentOptions}) and later reads it back off a live
 * parent's options, which is why `AgentOptions` — the agent factory's contract,
 * which knows nothing about engines — does not declare it. Typing the read
 * against this instead of an inline cast is what lets a caller (and the
 * regression suite) hand the router options that carry the marker, which is
 * exactly the shape the parent always has.
 */
export type EngineMarkedAgentOptions = AgentOptions & FreeCodeGoAgentOptions & { readonly engine?: string }

/** Read the durable engine marker from a live parent agent. */
export function inheritedEngineOf(options: EngineMarkedAgentOptions | undefined): AgentEngineId | undefined {
  return options?.engine === 'deepseek' || options?.engine === 'codex' || options?.engine === 'claude'
    ? options.engine
    : options?.freeCodeGoEngine === 'deepseek' || options?.freeCodeGoEngine === 'codex' || options?.freeCodeGoEngine === 'claude'
      ? options.freeCodeGoEngine
      : undefined
}

/** Force a child request to stay on its parent's execution engine. */
export function enforceSameEngine(
  options: EngineMarkedAgentOptions | undefined,
  parentOptions: EngineMarkedAgentOptions | undefined,
): RoutedAgentOptions {
  const engine = inheritedEngineOf(parentOptions)
  return engine === undefined ? { ...(options ?? {}) } : { ...(options ?? {}), engine }
}

/**
 * Whether a provider is one an engine's *child* admission accepts.
 *
 * Two spellings are refused for a native engine: the other engine's native
 * marker, and the two Host-adapter providers (`deepseek-official`, `freecodego`).
 * The second pair is refused because a child carrying one is presumed to have
 * inherited the Web API's ordinary default rather than chosen it — the router's
 * `isOrdinaryDefaultRoute` treats exactly those two as that default — and a
 * native child's route is the parent's to decide.
 *
 * Deliberately not the question {@link namesForeignEngine} asks, because that one
 * is asked of a *parent's* pair: a parent naming `freecodego` is running its own
 * configured route (the Claude engine reaches the gateway through the plugin's
 * bridge, and `freecodego` is that engine's own default provider), so only
 * another engine's native marker disqualifies it. Loosening this function to
 * match that one would let the ordinary default leak into a native child, and
 * changing `defaultProviderForEngine` instead would break the durable route
 * binding the resume path reads back.
 *
 * An absent engine imposes no constraint: a parent that never crossed the
 * router carries no marker, and such a parent inherits its route unchanged.
 */
function providerFitsEngine(engine: AgentEngineId | undefined, provider: string | undefined): boolean {
  if (engine === undefined || provider === undefined) return true
  if (engine === 'deepseek') return provider !== 'codex' && provider !== 'claude'
  if (engine === 'codex') return provider !== 'claude' && provider !== 'deepseek-official' && provider !== 'freecodego'
  return provider !== 'codex' && provider !== 'deepseek-official' && provider !== 'freecodego'
}

/**
 * Whether a provider names a *different engine's* native protocol.
 *
 * This is the question asked of a parent's own pair, and it is deliberately
 * narrower than {@link providerFitsEngine}: a Host-adapter provider is not
 * foreign to a native engine — the Claude engine reaches every Host provider
 * through the plugin's bridge, and `freecodego` is the provider its own default
 * route uses — so only another engine's native marker disqualifies a parent
 * route. A parent that claims `engine: 'deepseek'` while running the `codex`
 * provider is the case this refuses.
 */
function namesForeignEngine(engine: AgentEngineId | undefined, provider: string | undefined): boolean {
  if (engine === undefined || provider === undefined) return false
  if (provider === 'codex') return engine !== 'codex'
  if (provider === 'claude') return engine !== 'claude'
  return false
}

/**
 * The provider an engine runs when the caller named none.
 *
 * Codex owns the `codex` provider id; Claude runs the Anthropic facade through
 * the plugin's bridge to the `freecodego` gateway; the Host LLM adapter's
 * ordinary route belongs to the DeepSeek engine. Letting one default stand for
 * all three minted a durable binding that named `deepseek-official` for a native
 * session, and the native-or-loop decision read from that same value.
 */
export function defaultProviderForEngine(engine: AgentEngineId): string {
  if (engine === 'codex') return 'codex'
  if (engine === 'claude') return 'freecodego'
  return 'deepseek-official'
}

/** The provider a session is admitted with: the caller's value, or the engine's own. */
export function effectiveProviderOf(engine: AgentEngineId, provider: string | undefined): string {
  const named = provider?.trim()
  return named === undefined || named === '' ? defaultProviderForEngine(engine) : named
}

/** Preserve the parent's route when a Team child omits provider/model fields. */
export function inheritSameEngineRoute(
  options: EngineMarkedAgentOptions | undefined,
  parentOptions: EngineMarkedAgentOptions | undefined,
): RoutedAgentOptions {
  const child = enforceSameEngine(options, parentOptions)
  const parent = parentOptions
  const engine = inheritedEngineOf(parentOptions)
  // A child route that names a foreign provider is the Web API's ordinary
  // default leaking into a native child, so it yields to the parent's route —
  // but only when that route actually fits the engine being enforced. A parent
  // that itself carries a foreign pair (`engine: 'deepseek'` with
  // `provider: 'codex'`) contributes nothing: its provider and its model belong
  // to a protocol this engine cannot run, and rewriting one into the other
  // would hand the child a route that never existed.
  const parentRouteFitsEngine = !namesForeignEngine(engine, parent?.provider)
  const incompatibleProvider = child.provider !== undefined && !providerFitsEngine(engine, child.provider)
  const inheritsParentRoute = parentRouteFitsEngine && (child.provider === undefined || incompatibleProvider)
  const effectiveProvider = inheritsParentRoute && parent?.provider !== undefined ? parent.provider : child.provider
  // The model travels with the route it was minted for, so it is inherited only
  // while the effective provider *is* the parent's. Inheriting it whenever the
  // child omitted a model paired the parent's model id with a provider the child
  // named itself — a request for a model that provider never served, which is the
  // same mismatch the provider rule above refuses, one field over.
  const inheritsParentModel = child.model === undefined
    && parent?.model !== undefined
    && parentRouteFitsEngine
    && effectiveProvider === parent.provider
  return {
    ...child,
    ...(inheritsParentRoute && parent?.provider !== undefined ? { provider: parent.provider } : {}),
    ...(inheritsParentModel ? { model: parent.model } : {}),
  }
}
