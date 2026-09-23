/**
 * Automatically authorize the live text-model directory for Subagent delegation.
 *
 * Reads and writes use the settings service's 0.1.7 seam. That revision removed
 * `get(ns)` — `describe()` is the only public read — and it is also where the
 * revision a write must carry comes from, so a read-modify-write cannot clobber
 * a concurrent edit by the user or another plugin.
 *
 * The removal was silent here, which is why this note exists: `settings.get(ns)`
 * threw the moment the method went away, and the one caller's catch swallowed
 * it, so automatic Subagent model routing applied no routes at all without a
 * symptom to notice. Any read of a service that is not the one this module
 * declares must be modelled against the shipped service, not against this
 * module's idea of it.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'

const SUBAGENT_MODEL_SELECTION_NAMESPACE = 'subagent-model-selection' as SettingsNamespace

interface ModelRoute {
  readonly provider: string
  readonly model: string
}

interface ModelEntry {
  readonly id: string
  readonly inputModalities?: readonly string[]
  readonly availability?: string
}

interface ModelDirectoryRuntime {
  listProviders(): readonly { readonly id: string }[]
  listModels(provider: string): Promise<readonly ModelEntry[]>
}

/**
 * The settings service, as this module consumes it.
 *
 * A structural copy of the shipped surface rather than an import: the service is
 * a Host peer, and `describe()` plus the revision-guarded `update()` are the two
 * calls this module is allowed to make.
 */
interface SettingsRuntime {
  /** Every composed settings entry, with its live value and revision. */
  describe(): readonly SettingsDescriptorView[]
  /** Write one entry's section, guarded by the revision it was read at. */
  update(namespace: string, patch: object, expectedRevision?: number): Promise<void>
}

/** The descriptor fields this module reads. */
interface SettingsDescriptorView {
  /** Entry id, which is what a settings read addresses. */
  readonly ns: string
  /** The entry's live value. */
  readonly value: unknown
  /** Revision to hand back to {@link SettingsRuntime.update}. */
  readonly revision: number
}

function routesOf(value: unknown): ModelRoute[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  const routes = (value as { allowedModels?: unknown }).allowedModels
  if (!Array.isArray(routes)) return []
  return routes.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
    const route = entry as { provider?: unknown; model?: unknown }
    return typeof route.provider === 'string' && typeof route.model === 'string'
      ? [{ provider: route.provider, model: route.model }]
      : []
  })
}

function sameRoutes(left: readonly ModelRoute[], right: readonly ModelRoute[]): boolean {
  return left.length === right.length
    && left.every((route, index) => route.provider === right[index]?.provider && route.model === right[index]?.model)
}

/** Synchronize one authoritative catalog generation into the official setting.
 * @param settings - the settings runtime the selection lives in.
 * @param llm - the model directory the routes are derived from.
 * @returns the model Route rows, in backend order.
 */
export async function synchronizeSubagentModelRoutes(
  settings: SettingsRuntime,
  llm: ModelDirectoryRuntime,
): Promise<readonly ModelRoute[]> {
  // No descriptor means the composition declares no such entry: writing one here
  // would create a setting the user never asked for.
  const descriptor = settings.describe().find(row => row.ns === SUBAGENT_MODEL_SELECTION_NAMESPACE)
  if (descriptor === undefined) return []
  const current = descriptor.value
  const previous = routesOf(current)
  const previousByProvider = new Map<string, ModelRoute[]>()
  for (const route of previous) {
    const routes = previousByProvider.get(route.provider) ?? []
    routes.push(route)
    previousByProvider.set(route.provider, routes)
  }

  const providers = llm.listProviders().filter(provider => provider.id.trim() !== '')
  // Track which providers returned a catalog at all: a provider whose listing
  // SUCCEEDED but is empty is authoritative (its routes are gone), while a
  // provider that threw keeps its previous routes for this round.
  const answeredProviders = new Set<string>()
  const listed = await Promise.all(providers.map(async (provider) => {
    try {
      const models = await llm.listModels(provider.id)
      answeredProviders.add(provider.id)
      return models.flatMap((model): ModelRoute[] => {
        if (model.id.trim() === '' || model.availability === 'unavailable') return []
        if (model.inputModalities !== undefined && !model.inputModalities.includes('text')) return []
        return [{ provider: provider.id, model: model.id }]
      })
    } catch {
      // Preserve the last authorized routes for a provider whose advisory
      // catalog is temporarily unavailable.
      return previousByProvider.get(provider.id) ?? []
    }
  }))
  const seen = new Set<string>()
  const routes = listed.flat().filter((route) => {
    const key = `${route.provider}\0${route.model}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (routes.length === 0) return previous

  const currentRecord = typeof current === 'object' && current !== null && !Array.isArray(current)
    ? current as Record<string, unknown>
    : {}
  // Routes of providers that no longer exist in the directory (removed
  // adapters) must not persist forever: drop them, but keep routes for live
  // providers whose catalogs were momentarily unavailable this round. A live
  // provider that answered with an EMPTY catalog is authoritative — its stale
  // routes are dropped — while an unanswered provider keeps its previous rows.
  const liveProviders = new Set(providers.map(provider => provider.id))
  const retained = previous.filter(route =>
    liveProviders.has(route.provider)
    && !answeredProviders.has(route.provider)
    && !routes.some(candidate => candidate.provider === route.provider),
  )
  const filtered = [...routes, ...retained.filter(route => !routes.some(candidate => candidate.provider === route.provider && candidate.model === route.model))]
  const patch: Record<string, unknown> = { ...currentRecord, allowedModels: filtered }
  // `enabled` is the user's opt-out switch (owned by the tool-subagent
  // settings); only seed it when absent so a catalog sync never silently
  // re-enables a feature the user turned off.
  if (currentRecord.enabled === undefined) patch.enabled = true
  if (!sameRoutes(previous, filtered) || currentRecord.enabled === undefined) {
    await settings.update(SUBAGENT_MODEL_SELECTION_NAMESPACE, patch, descriptor.revision)
  }
  return filtered
}

/** Coalesces topology updates while one catalog synchronization is running. */
export class FreeCodeGoSubagentModelRouting {
  private pending: Promise<void> | undefined
  private rerun = false
  private disposed = false

  constructor(private readonly ctx: Context, enabled: boolean) {
    if (!enabled) return
    ctx.on('llm/adapters-updated', () => { this.refresh() })
    ctx.on('credentials/reference-updated', () => { this.refresh() })
    ctx.on('credentials/record-updated', () => { this.refresh() })
    queueMicrotask(() => { this.refresh() })
  }

  /** Re-derive the routes from the current catalog, coalescing concurrent calls. */
  refresh(): void {
    if (this.disposed) return
    if (this.pending !== undefined) {
      this.rerun = true
      return
    }
    const settings = this.ctx.get('settings') as SettingsRuntime | undefined
    const llm = this.ctx.get('llm') as ModelDirectoryRuntime | undefined
    if (settings === undefined || llm === undefined) return
    const operation = (async () => {
      let retries = 0
      do {
        this.rerun = false
        try {
          await synchronizeSubagentModelRoutes(settings, llm)
          retries = 0
        } catch {
          // Advisory, and reachable in normal operation: a write loses its
          // revision race the moment the user edits the settings page in the
          // same second. One retry re-reads and reapplies; a second failure
          // waits for the next catalog or credential event rather than looping.
          if (retries >= 1 || this.disposed) break
          retries += 1
          this.rerun = true
        }
      } while (this.rerun && !this.disposed)
    })().catch(() => undefined).finally(() => {
      if (this.pending === operation) this.pending = undefined
    })
    this.pending = operation
  }

  /** Stop applying refreshes once the Host is disposing. */
  dispose(): void {
    this.disposed = true
  }
}
