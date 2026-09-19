/** FreeCodeGo's engine lease registry, kept inside the plugin boundary. */

import type { Context, Disposable } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  AgentEngineAvailability,
  AgentEngineDefinition,
  AgentEngineId,
  AgentEnginePlan,
  AgentEnginePlanInput,
  AgentEngineSnapshot,
} from '@deepseek-ai/dsh-freecodego-root-agent'

export type { AgentEngineAvailability, AgentEngineDefinition, AgentEngineId, AgentEnginePlan, AgentEnginePlanInput, AgentEngineSnapshot } from '@deepseek-ai/dsh-freecodego-root-agent'

export interface AgentEngineLease {
  readonly sessionId: SessionId
  readonly plan: AgentEnginePlan
  readonly state: 'reserved' | 'active' | 'released'
  publish(): void
  release(): void
}

interface Entry {
  readonly definition: AgentEngineDefinition
  readonly generation: number
  availability: AgentEngineAvailability
  draining: boolean
  readonly leases: Map<SessionId, Lease>
}

class Lease implements AgentEngineLease {
  state: 'reserved' | 'active' | 'released' = 'reserved'
  constructor(readonly sessionId: SessionId, readonly plan: AgentEnginePlan, private readonly entry: Entry, private readonly onRelease: () => void) {}
  publish(): void {
    if (this.state !== 'reserved') throw new Error(`engine lease for session "${this.sessionId}" is not reserved`)
    this.state = 'active'
  }
  release(): void {
    if (this.state === 'released') return
    this.state = 'released'
    // A concurrent reserve with the same session id may have replaced this
    // lease in the map; deleting by key alone would evict the newer,
    // still-active lease and detach its engine from the registry.
    if (this.entry.leases.get(this.sessionId) === this) this.entry.leases.delete(this.sessionId)
    this.onRelease()
  }
}

/** Process-local leases for the plugin's optional native engines. */
export class FreeCodeGoAgentEngineRegistry {
  private readonly entries = new Map<AgentEngineId, Entry>()
  private readonly retiring = new Set<Entry>()
  private readonly generations = new Map<AgentEngineId, number>()
  constructor(private readonly ctx: Context) {}

  /**
   * Register an engine and hand back the disposer `ctx.effect` created.
   *
   * The declared type used to be `() => void`, but the effect disposer returns
   * the teardown promise, so the signature described something the function did
   * not return — `no-misused-promises` reported exactly that. Callers that drop
   * the return value are unaffected; a caller that awaits it now can.
   */
  register(definition: AgentEngineDefinition): Disposable<Promise<void>> {
    return this.ctx.effect(() => {
      if (this.entries.has(definition.id)) throw new Error(`agent engine "${definition.id}" is already registered`)
      const generation = (this.generations.get(definition.id) ?? 0) + 1
      this.generations.set(definition.id, generation)
      const entry: Entry = { definition, generation, availability: definition.availability, draining: false, leases: new Map() }
      this.entries.set(definition.id, entry)
      return () => { this.retire(definition.id, entry); this.removeWhenDrained(definition.id, entry) }
    }, `freeCodeGoAgentEngines.register(${definition.id})`)
  }

  async reserve(id: AgentEngineId, sessionId: SessionId, input: AgentEnginePlanInput): Promise<AgentEngineLease> {
    const entry = this.requireAvailable(id)
    if (entry.leases.has(sessionId)) throw new Error(`session "${sessionId}" already has an engine lease`)
    const created = await entry.definition.createPlan(input)
    // Concurrent reserves for the same session both pass the pre-await check.
    // Nothing between this re-check and the `leases.set` below awaits, so the
    // two statements run as one synchronous block: whoever resumes first
    // inserts its lease and the loser throws here instead of replacing the
    // winner in the map. Splitting them with an await would leave the winner
    // tracked only through `Lease.release`'s identity check, so the insert is
    // the sole admission point on purpose.
    if (entry.leases.has(sessionId)) throw new Error(`session "${sessionId}" already has an engine lease`)
    if (entry.draining || entry.availability !== 'available' || this.entries.get(id) !== entry) throw new Error(`agent engine "${id}" became unavailable while planning the session`)
    const plan: AgentEnginePlan = { ...created, engineId: id, generation: entry.generation }
    const lease = new Lease(sessionId, plan, entry, () => { this.removeWhenDrained(id, entry) })
    entry.leases.set(sessionId, lease)
    return lease
  }

  async reserveExisting(plan: AgentEnginePlan, sessionId: SessionId): Promise<AgentEngineLease> {
    const candidates = [this.entries.get(plan.engineId), ...this.retiring].filter((entry): entry is Entry => entry !== undefined)
    const entry = candidates.find(candidate => candidate.definition.id === plan.engineId && candidate.generation === plan.generation)
    if (entry === undefined) throw new Error(`agent engine "${plan.engineId}" generation ${String(plan.generation)} is not installed`)
    this.requireAdmissible(plan.engineId, entry)
    if (entry.leases.has(sessionId)) throw new Error(`session "${sessionId}" already has an engine lease`)
    const created = await entry.definition.createPlan({ modelId: plan.modelId, routeBindingId: plan.routeBindingId, catalogRevision: plan.catalogRevision, capabilityFingerprint: plan.capabilityFingerprint })
    // Revalidate after the await: the matched entry may have been fully
    // drained out of the registry (leases hit zero) while planning, and a
    // lease attached to a detached entry would be invisible to every snapshot.
    if (![this.entries.get(plan.engineId), ...this.retiring].includes(entry)) {
      throw new Error(`agent engine "${plan.engineId}" generation ${String(plan.generation)} was removed while planning the session`)
    }
    if (entry.leases.has(sessionId)) throw new Error(`session "${sessionId}" already has an engine lease`)
    // Availability can flip while `createPlan` awaits — the router reconciles
    // the native runtimes on a timer — so the admission rule that was applied
    // when the entry was matched is applied again on the far side of the await.
    this.requireAdmissible(plan.engineId, entry)
    const reference: AgentEnginePlan = { ...created, engineId: plan.engineId, generation: plan.generation }
    // Compare every key either side carries rather than a hand-listed subset: a
    // field added to `AgentEnginePlan` afterwards is covered by construction,
    // and a key the durable plan no longer carries is a mismatch instead of a
    // comparison that silently finds nothing.
    const planFields: Record<string, unknown> = { ...plan }
    const referenceFields: Record<string, unknown> = { ...reference }
    const incompatibleField = [...new Set([...Object.keys(planFields), ...Object.keys(referenceFields)])]
      .find(field => planFields[field] !== referenceFields[field])
    if (incompatibleField !== undefined) {
      throw new Error(`agent engine "${plan.engineId}" durable plan is incompatible with the installed runtime: ${incompatibleField}`)
    }
    const lease = new Lease(sessionId, plan, entry, () => { this.removeWhenDrained(plan.engineId, entry) })
    entry.leases.set(sessionId, lease)
    return lease
  }

  beginDrain(id: AgentEngineId): { id: AgentEngineId; generation: number; activeLeaseCount: number } {
    const entry = this.requireEntry(id)
    this.retire(id, entry)
    this.removeWhenDrained(id, entry)
    return { id, generation: entry.generation, activeLeaseCount: entry.leases.size }
  }
  setAvailability(id: AgentEngineId, availability: AgentEngineAvailability): void { this.requireEntry(id).availability = availability }
  snapshot(): AgentEngineSnapshot[] { return [...this.entries.values(), ...this.retiring].map(entry => ({ id: entry.definition.id, generation: entry.generation, availability: entry.availability, reasons: entry.definition.reasons ?? [], draining: entry.draining, activeLeaseCount: entry.leases.size })) }
  private requireEntry(id: AgentEngineId): Entry { const entry = this.entries.get(id); if (entry === undefined) throw new Error(`agent engine "${id}" is not registered`); return entry }
  /**
   * Refuse an engine that is not admitting sessions, naming the reasons it
   * published for its own state.
   *
   * A *draining* entry is deliberately admitted here: restoring a session that
   * was pinned to an engine has to outlive a retire, which is why
   * `reserveExisting` matches against `retiring` at all. Availability is a
   * different fact — the runtime is missing or being replaced — and no lease
   * can be honoured in that state.
   */
  private requireAdmissible(id: AgentEngineId, entry: Entry): void {
    if (entry.availability === 'available') return
    const reasons = entry.definition.reasons ?? []
    throw new Error(`agent engine "${id}" is ${entry.availability}${reasons.length === 0 ? '' : `: ${reasons.join(', ')}`}`)
  }
  private requireAvailable(id: AgentEngineId): Entry {
    const entry = this.requireEntry(id)
    if (entry.draining) throw new Error(`agent engine "${id}" is draining`)
    this.requireAdmissible(id, entry)
    return entry
  }
  /** Retire an entry, then let `removeWhenDrained` drop it once its last lease
   * is released. Both call sites pair the two in one synchronous block, which is
   * what keeps `retiring` from holding an entry nothing will remove again. */
  private retire(id: AgentEngineId, entry: Entry): void { entry.draining = true; if (this.entries.get(id) === entry) this.entries.delete(id); this.retiring.add(entry) }
  private removeWhenDrained(id: AgentEngineId, entry: Entry): void { if (!entry.draining || entry.leases.size !== 0) return; if (this.entries.get(id) === entry) this.entries.delete(id); this.retiring.delete(entry) }
  /** Snapshot of live (non-draining) entries only. Registration checks use
   * this: a draining entry left behind by HMR retire must not make the next
   * registration skip itself and later fail every reserve with "not
   * registered". */
  liveIds(): readonly AgentEngineId[] {
    return [...this.entries.values()].filter(entry => !entry.draining).map(entry => entry.definition.id)
  }
}

declare module '@deepseek-ai/cordis' { interface Context { agentEngines: FreeCodeGoAgentEngineRegistry } }
