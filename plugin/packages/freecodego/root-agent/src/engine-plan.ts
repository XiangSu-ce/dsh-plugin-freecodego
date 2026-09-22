/** Durable FreeCodeGo engine plan and session binding for Harness 0.1.3. */

import type { Session, SessionId } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Records which native engine this Session is bound to, and the runtime
     * identity the binding was made against.
     *
     * The binding is durable so that a resumed Session cannot silently change
     * what its earlier turns meant: `ensureAgentEngineBinding` refuses to
     * continue unless every field below still matches the requested plan. The
     * payload carries the whole runtime identity for that reason — `engineId` and
     * `generation` name the engine, `modelId` and `routeBindingId` the route it
     * ran, and `artifactDigest` / `protocolAbi` / `catalogRevision` /
     * `capabilityFingerprint` turn an engine or catalog update into a refusal
     * rather than a quiet reinterpretation of the transcript.
     */
    'agent-engine/selected': {
      readonly engineId: string
      readonly generation: number
      readonly artifactDigest: string
      readonly protocolAbi: string
      readonly modelId: string
      readonly routeBindingId: string
      readonly catalogRevision: string
      readonly capabilityFingerprint: string
    }
  }
}

/** Root-agent implementations available to the FreeCodeGo router. */
export type AgentEngineId = 'deepseek' | 'codex' | 'claude'

/** Availability used when admitting a new session. */
export type AgentEngineAvailability = 'available' | 'unavailable' | 'updating'

/** Immutable route and runtime identity leased for one Harness session. */
export interface AgentEnginePlan {
  readonly engineId: AgentEngineId
  readonly generation: number
  readonly artifactDigest: string
  readonly protocolAbi: string
  readonly modelId: string
  readonly routeBindingId: string
  readonly catalogRevision: string
  readonly capabilityFingerprint: string
}

/** Engine implementation metadata used by the plugin-owned registry. */
export interface AgentEngineDefinition {
  readonly id: AgentEngineId
  readonly availability: AgentEngineAvailability
  readonly reasons?: readonly string[]
  createPlan(input: AgentEnginePlanInput): Promise<Omit<AgentEnginePlan, 'engineId' | 'generation'>>
}

/** Redacted engine inventory row exposed to FreeCodeGo settings surfaces. */
export interface AgentEngineSnapshot {
  readonly id: AgentEngineId
  readonly generation: number
  readonly availability: AgentEngineAvailability
  readonly reasons: readonly string[]
  readonly draining: boolean
  readonly activeLeaseCount: number
}

/** Non-secret route values supplied before a lease is published. */
export interface AgentEnginePlanInput {
  readonly modelId: string
  readonly routeBindingId: string
  readonly catalogRevision: string
  readonly capabilityFingerprint: string
}

/** Transient native execution details carried while a routed Agent is opened. */
export interface FreeCodeGoNativePlan {
  readonly engine: 'codex' | 'claude'
  readonly modelId: string
  readonly provider: string
  readonly artifactDigest: string
  readonly protocolAbi: string
}

/** FreeCodeGo-owned fields layered on top of the public Harness Agent options. */
export interface FreeCodeGoAgentOptions {
  readonly freeCodeGoNative?: FreeCodeGoNativePlan
  /** Explicit engine identity for a new root or engineering-team child Session. */
  readonly freeCodeGoEngine?: AgentEngineId
  /** Restricts an engineering-team child to non-mutating native engine tools. */
  readonly freeCodeGoReadOnly?: boolean
}

/** Durable event binding that prevents an incompatible runtime from resuming. 
 * @param session - the durable session the binding belongs to.
 * @param plan - the engine plan this session is being opened with.
 */
export function ensureAgentEngineBinding(session: Session, plan: AgentEnginePlan): void {
  const existing = session.snapshotEvents().find(event => event.type === 'agent-engine/selected')
  if (existing === undefined) {
    session.append('agent-engine/selected', {
      engineId: plan.engineId,
      generation: plan.generation,
      artifactDigest: plan.artifactDigest,
      protocolAbi: plan.protocolAbi,
      modelId: plan.modelId,
      routeBindingId: plan.routeBindingId,
      catalogRevision: plan.catalogRevision,
      capabilityFingerprint: plan.capabilityFingerprint,
    })
    return
  }
  const binding: Record<string, unknown> = { ...existing.data }
  const requested: Record<string, unknown> = { ...plan }
  // Compare every key either side carries rather than a hand-listed subset: a
  // field added to `AgentEnginePlan` afterwards is covered by construction, and
  // a key the stored binding no longer carries is a mismatch instead of a
  // comparison that silently finds nothing to check. The mismatching field is
  // named because the two records differ in one value and not in identity.
  const mismatch = [...new Set([...Object.keys(binding), ...Object.keys(requested)])]
    .find(field => binding[field] !== requested[field])
  if (mismatch !== undefined) {
    throw new Error(`session "${session.id}" engine binding does not match the requested plan: ${mismatch}`)
  }
}

/**
 * The provider a durable route binding was minted with.
 *
 * `AgentEnginePlan` keeps the route as one string, so a consumer that needs the
 * provider back — the native opener, which must not hand a worker the whole
 * `harness:<provider>:<model>` text as a provider name — reads it through here.
 * Bindings have carried this format since the first alpha release, so an older
 * session's binding parses like a current one.
 * @param routeBindingId - the durable `harness:<provider>:<model>` route binding.
 * @returns the provider that binding was minted with, or `undefined` when it is not in that format.
 */
export function routeProvider(routeBindingId: string): string | undefined {
  return /^harness:([^:]+):/u.exec(routeBindingId)?.[1]
}

/** Branded session identity is intentionally re-exported with the plan seam. */
export type { SessionId }
