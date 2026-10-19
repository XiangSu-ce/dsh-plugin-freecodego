/**
 * Read and write the per-provider / per-model settings the tuning surface owns.
 *
 * Why this exists
 * --------------
 * The Models entry (`llm-pi-ai`) is where a route's capacities live: a model's
 * `contextWindow` and `maxTokens`, its offered `reasoningEfforts`, and the
 * route-level `defaultContextWindow` / `defaultMaxTokens` / `reasoning` that
 * answer for models stating none of their own. The Harness Models page edits
 * those fields one hand-written entry at a time, and a **catalog** route — the
 * common case, where the model list comes from the installed pi-ai catalog —
 * has no entry to edit at all. A user whose provider serves a larger window than
 * the catalog records, or whose hand-declared endpoint states no thinking level,
 * therefore has nowhere to say so.
 *
 * This module is that surface's other half: it enumerates every route and model
 * the `llm` service can serve, reports what each one currently resolves to and
 * which layer answered, and writes an edit back into the user's own Models
 * document. A declared route is edited in place (`models[i]`); a catalog route
 * gains a `modelOverrides` entry, which is the schema's supported way to reshape
 * one catalog model without restating the other thirty-seven.
 *
 * Additive and reversible
 * -----------------------
 * A write only ever names the field it was asked to change, through the settings
 * service's path mutation, so a wholesale `replace` built from a redacted
 * descriptor can never delete the API keys it did not return. `null` is an
 * explicit clear, which is how a user returns a model to the catalog's answer.
 *
 * Best-effort like every other write this plugin makes: an absent or locked
 * settings service, or an `llm` service that cannot answer, degrades to a
 * read-only snapshot rather than failing the surface.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/model-tuning
 */

import type { Context } from '@deepseek-ai/cordis'
import { contextBufferForWindow } from './context-budget.ts'
import { MODELS_SETTINGS_ENTRY } from './peer-settings.ts'
import { maybeRecord } from './untrusted-json.ts'
import type {
  FreeCodeGoModelTuning,
  FreeCodeGoModelTuningSnapshot,
  FreeCodeGoModelTuningWrite,
  FreeCodeGoProviderTuning,
  FreeCodeGoReasoningLevel,
  FreeCodeGoTuningSource,
} from './types.ts'

/**
 * The thinking levels this surface offers, in escalation order.
 *
 * `off` first because it is the level that sends nothing, and the two larger
 * tiers (`xhigh`, `max`) are the ones this surface adds over the four the
 * hand-declared-model declaration used to name.
 */
export const OFFERED_REASONING_LEVELS: readonly FreeCodeGoReasoningLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max']

/** The wire spelling each offered level sends; `off` sends the parameter's absence. */
const REASONING_WIRE: Readonly<Record<Exclude<FreeCodeGoReasoningLevel, 'off'>, string>> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
}

/** Context lengths the presets offer, ascending. A starting point, not a limit. */
export const CONTEXT_PRESETS: readonly number[] = [128_000, 200_000, 256_000, 270_000, 512_000, 1_000_000, 1_048_576]

/** One path-addressed edit, as the settings service's mutation spells it. */
type SettingsPathOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

/** The settings service, as this module reads it. */
interface SettingsEditor {
  describe(): readonly { readonly ns: string; readonly value: unknown }[]
  mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
}

/** The `llm` directory, as this module reads it. */
interface LlmDirectory {
  listProviders(): readonly { readonly id: string; readonly name: string }[]
  listModels(provider: string): Promise<readonly { readonly id: string; readonly name: string }[]>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{
    readonly context?: { readonly contextWindow: number }
    readonly defaultMaxTokens?: number
    readonly reasoning?: { readonly efforts: readonly { readonly id: string }[] }
  }>
  /**
   * Every route an adapter can activate through configuration, whether or not
   * one serves it right now. Absent on an older `llm` service, which then
   * reports live routes only.
   */
  listConfigurableProviders?(): readonly { readonly provider: string; readonly displayName: string }[]
}

/** Resolve the settings service, or `undefined` when it is not up. */
function settingsEditor(ctx: Context): SettingsEditor | undefined {
  let candidate: unknown
  try { candidate = ctx.get('settings') } catch { return undefined }
  const view = candidate as Partial<SettingsEditor> | undefined
  if (view === undefined) return undefined
  return typeof view.describe === 'function' && typeof view.mutate === 'function'
    ? view as SettingsEditor
    : undefined
}

/** Resolve the `llm` service, or `undefined` when it is not up. */
function llmDirectory(ctx: Context): LlmDirectory | undefined {
  let candidate: unknown
  try { candidate = ctx.get('llm') } catch { return undefined }
  const view = candidate as Partial<LlmDirectory> | undefined
  if (view === undefined) return undefined
  return typeof view.listProviders === 'function' && typeof view.listModels === 'function'
    ? view as LlmDirectory
    : undefined
}

/** A stored route profile plus its `providers` siblings, as this module reads them. */
interface StoredProviders {
  readonly providers: Record<string, unknown>
  readonly descriptor?: { readonly ns: string; readonly value: unknown }
}

/** Read the Models entry's stored `providers` dict, when one is mounted. */
function storedProviders(settings: SettingsEditor | undefined): StoredProviders {
  if (settings === undefined) return { providers: {} }
  let descriptor: { readonly ns: string; readonly value: unknown } | undefined
  try { descriptor = settings.describe().find(row => row.ns === MODELS_SETTINGS_ENTRY) } catch { return { providers: {} } }
  const providers = maybeRecord(maybeRecord(descriptor?.value)?.providers)
  return { providers: providers ?? {}, ...descriptor === undefined ? {} : { descriptor } }
}

/**
 * The stored value of one model field and where it sits.
 *
 * A declared route spells models out in `models`, where the id is a field; a
 * catalog route reshapes one entry through `modelOverrides`, keyed by id. Both
 * are reported, so a write lands where the value already lives instead of
 * creating a second, disagreeing copy.
 */
interface StoredModel {
  /** The `models` index, when the route declares its models. */
  readonly index?: number
  /** The `modelOverrides` entry, when the route reshapes catalog models. */
  readonly override?: Record<string, unknown>
  /** The `models` entry, when the route declares its models. */
  readonly entry?: Record<string, unknown>
}

/** Locate one model in a route's stored profile. */
function storedModel(profile: Record<string, unknown> | undefined, model: string): StoredModel {
  const models = profile?.models
  if (Array.isArray(models)) {
    const index = models.findIndex(entry => maybeRecord(entry)?.id === model)
    if (index >= 0) return { index, entry: maybeRecord(models[index]) ?? {} }
  }
  const override = maybeRecord(maybeRecord(profile?.modelOverrides)?.[model])
  return override === undefined ? {} : { override }
}

/**
 * The context windows the user's Models entry states for one route's models.
 *
 * A window this surface writes is read back by pi-ai, which serves the routes
 * pi-ai itself owns. A route the plugin serves from its own directory is not one
 * of them: its adapter declares one window for every row the directory names, so
 * without this read a saved edit changes the stored document and nothing about
 * the window that route resolves at.
 *
 * Best-effort like the rest of this module: an absent settings service, an
 * unreadable document, or a value that is not a positive integer states no
 * override, and the caller keeps its own default.
 * @param ctx - context carrying the settings service.
 * @param provider - the route whose stored models are read.
 * @returns each model id the entry states a window for; empty when none is stated.
 */
export function storedContextWindows(ctx: Context, provider: string): ReadonlyMap<string, number> {
  const profile = maybeRecord(storedProviders(settingsEditor(ctx)).providers[provider])
  const windows = new Map<string, number>()
  const models = profile?.models
  if (Array.isArray(models)) {
    for (const entry of models) {
      const row = maybeRecord(entry)
      const id = typeof row?.id === 'string' ? row.id : undefined
      const window = storedNumber(row, 'contextWindow')
      if (id !== undefined && window !== undefined) windows.set(id, window)
    }
  }
  // Last, so an override wins over a declared entry that names the same id.
  for (const [id, entry] of Object.entries(maybeRecord(profile?.modelOverrides) ?? {})) {
    const window = storedNumber(maybeRecord(entry), 'contextWindow')
    if (window !== undefined) windows.set(id, window)
  }
  return windows
}

/** Map a stored or adapter-reported effort id onto an offered level. */
function toOfferedLevel(id: string): FreeCodeGoReasoningLevel | undefined {
  return (OFFERED_REASONING_LEVELS as readonly string[]).includes(id)
    ? id as FreeCodeGoReasoningLevel
    : undefined
}

/** The levels a stored `reasoningEfforts` value offers, or undefined when it is not a dict. */
function storedReasoningLevels(value: unknown): readonly FreeCodeGoReasoningLevel[] | undefined {
  const record = maybeRecord(value)
  if (record === undefined) return undefined
  const levels = OFFERED_REASONING_LEVELS.filter(level => record[level] !== undefined)
  return levels.some(level => level !== 'off') ? levels : undefined
}

/** The route's reasoning level, when it states one. */
function storedProviderReasoning(value: unknown): FreeCodeGoReasoningLevel | undefined {
  return typeof value === 'string' ? toOfferedLevel(value) : undefined
}

/** Build the write value for a set of offered levels: `off` sends nothing. */
function reasoningEffortsValue(levels: readonly FreeCodeGoReasoningLevel[]): Record<string, string | null> {
  const value: Record<string, string | null> = {}
  for (const level of OFFERED_REASONING_LEVELS) {
    if (!levels.includes(level)) continue
    value[level] = level === 'off' ? null : REASONING_WIRE[level]
  }
  return value
}

/** Read the stored numeric field of one model entry, when it states one. */
function storedNumber(source: Record<string, unknown> | undefined, field: string): number | undefined {
  const value = source?.[field]
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/** One model row plus the route profile it came from. */
interface ModelRow {
  readonly provider: string
  readonly providerName: string
  readonly model: string
  readonly name: string
  readonly profile: Record<string, unknown> | undefined
  readonly stored: StoredModel
  /** Whether an adapter serves this route now; a dormant row is declaration-only. */
  readonly live: boolean
}

/** One route this surface can speak about, live or dormant. */
interface RouteInfo {
  readonly provider: string
  readonly providerName: string
  readonly live: boolean
}

/** Routes an adapter declares as configurable, whether or not one serves them now. */
function configurableProviders(llm: LlmDirectory): readonly { readonly provider: string; readonly displayName: string }[] {
  if (typeof llm.listConfigurableProviders !== 'function') return []
  try { return llm.listConfigurableProviders() } catch { return [] }
}

/**
 * Every route this surface addresses, live routes first.
 *
 * A **dormant** route — declared in the Models settings with no adapter serving
 * it, because a credential is missing or its plugin has not mounted — is still a
 * route the user has to be able to shape before it activates, so it is listed
 * beside the live ones instead of waiting for a key to appear.
 */
function knownRoutes(llm: LlmDirectory): RouteInfo[] {
  const routes: RouteInfo[] = []
  const seen = new Set<string>()
  for (const provider of llm.listProviders()) {
    if (seen.has(provider.id)) continue
    seen.add(provider.id)
    routes.push({ provider: provider.id, providerName: provider.name, live: true })
  }
  for (const provider of configurableProviders(llm)) {
    if (seen.has(provider.provider)) continue
    seen.add(provider.provider)
    routes.push({ provider: provider.provider, providerName: provider.displayName, live: false })
  }
  return routes
}

/** The model ids a dormant route's stored profile declares. */
function declaredModels(profile: Record<string, unknown> | undefined): readonly string[] {
  const models = profile?.models
  if (!Array.isArray(models)) return []
  const ids: string[] = []
  for (const value of models) {
    const id = maybeRecord(value)?.id
    if (typeof id === 'string' && id !== '' && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * Enumerate every route and model this pass can speak about.
 *
 * A live route answers from its adapter. A dormant one answers from its stored
 * declaration, which is also where its names come from — an id and nothing else,
 * exactly what the Models page let the user write.
 */
async function modelRows(llm: LlmDirectory, stored: Record<string, unknown>): Promise<ModelRow[]> {
  const rows: ModelRow[] = []
  for (const route of knownRoutes(llm)) {
    const profile = maybeRecord(stored[route.provider])
    if (!route.live) {
      for (const model of declaredModels(profile)) {
        rows.push({
          provider: route.provider,
          providerName: route.providerName,
          model,
          name: model,
          profile,
          stored: storedModel(profile, model),
          live: false,
        })
      }
      continue
    }
    let models: readonly { readonly id: string; readonly name: string }[]
    try { models = await llm.listModels(route.provider) } catch { continue }
    for (const model of models) {
      rows.push({
        provider: route.provider,
        providerName: route.providerName,
        model: model.id,
        name: model.name,
        profile,
        stored: storedModel(profile, model.id),
        live: true,
      })
    }
  }
  return rows
}

/** Whether one row's model is named by the stored settings layer. */
function isDeclared(row: ModelRow): boolean {
  return row.stored.index !== undefined || row.stored.override !== undefined
}

/** One model's effective reasoning and the layer that answered it. */
interface ModelReasoning {
  readonly levels?: readonly FreeCodeGoReasoningLevel[]
  readonly source: FreeCodeGoTuningSource
}

/** Resolve one model's effective reasoning, with its source. */
async function modelReasoning(llm: LlmDirectory, row: ModelRow, storedEfforts: unknown): Promise<ModelReasoning> {
  if (storedEfforts === false) return { source: 'settings' }
  const declared = storedReasoningLevels(storedEfforts)
  if (declared !== undefined) return { levels: declared, source: 'settings' }
  try {
    const info = await llm.resolveModelInfo(row.provider, row.model)
    const levels = (info.reasoning?.efforts ?? [])
      .map(effort => toOfferedLevel(effort.id))
      .filter((level): level is FreeCodeGoReasoningLevel => level !== undefined)
    if (levels.length > 0) return { levels, source: 'catalog' }
  } catch { /* A route the adapter refuses answers "none"; the next read retries. */ }
  return { source: 'none' }
}

/**
 * The complete tuning snapshot: every route and model, each value with the layer
 * that answered it, and the constants the surface renders its hints from.
 * @param ctx - context carrying the settings and `llm` services.
 * @returns the snapshot the settings surface renders.
 */
export async function readModelTuning(ctx: Context): Promise<FreeCodeGoModelTuningSnapshot> {
  const settings = settingsEditor(ctx)
  const llm = llmDirectory(ctx)
  const stored = storedProviders(settings).providers
  const providers: FreeCodeGoProviderTuning[] = []
  const models: FreeCodeGoModelTuning[] = []
  if (llm !== undefined) {
    const routes = knownRoutes(llm)
    const rows = await modelRows(llm, stored)
    for (const route of routes) {
      // A dormant route with nothing declared still appears, carrying only its
      // route-level defaults: those are settable before the route activates.
      const group = rows.filter(row => row.provider === route.provider)
      const profile = group[0]?.profile ?? maybeRecord(stored[route.provider])
      // Read each fallback once, so the presence test and the value are the same
      // read rather than two that a strict optional type cannot reconcile.
      const defaultContextWindow = storedNumber(profile, 'defaultContextWindow')
      const defaultMaxTokens = storedNumber(profile, 'defaultMaxTokens')
      const routeReasoning = storedProviderReasoning(profile?.reasoning)
      providers.push({
        provider: route.provider,
        providerName: route.providerName,
        modelCount: group.length,
        live: route.live,
        ...(defaultContextWindow === undefined ? {} : { defaultContextWindow }),
        ...(defaultMaxTokens === undefined ? {} : { defaultMaxTokens }),
        ...(routeReasoning === undefined ? {} : { reasoning: routeReasoning }),
      })
      for (const row of group) {
        const entry = row.stored.entry ?? row.stored.override
        const declaredContext = storedNumber(entry, 'contextWindow')
        let effectiveContext: number | undefined
        let effectiveMax: number | undefined
        try {
          const info = await llm.resolveModelInfo(row.provider, row.model)
          effectiveContext = info.context?.contextWindow
          effectiveMax = info.defaultMaxTokens
        } catch { /* reported as unknown below */ }
        const contextWindow = declaredContext !== undefined
          ? { value: declaredContext, source: 'settings' as const }
          : effectiveContext !== undefined
            ? { value: effectiveContext, source: 'catalog' as const }
            : { source: 'none' as const }
        const declaredMax = storedNumber(entry, 'maxTokens')
        // The adapter reports `defaultMaxTokens` only for a profile that named
        // its own `maxTokens`, so that answer is the settings layer's too —
        // unlike `context`, which the adapter also fills from the catalog.
        const maxOutputTokens = declaredMax !== undefined
          ? { value: declaredMax, source: 'settings' as const }
          : effectiveMax !== undefined
            ? { value: effectiveMax, source: 'settings' as const }
            : { source: 'none' as const }
        const reasoning = await modelReasoning(llm, row, entry?.reasoningEfforts)
        // Computed from the rule that actually fires, not a second copy of it:
        // the hint beside the context control is only useful if it names the
        // point where compaction really steps in on this model's window.
        const compactionAt = contextWindow.value === undefined
          ? undefined
          : Math.max(1, contextWindow.value - contextBufferForWindow(contextWindow.value))
        models.push({
          provider: row.provider,
          providerName: row.providerName,
          model: row.model,
          name: row.name,
          declared: isDeclared(row),
          contextWindow,
          maxOutputTokens,
          ...(compactionAt === undefined ? {} : { compactionAt }),
          ...(reasoning.levels === undefined ? {} : { reasoningLevels: reasoning.levels }),
          reasoningSource: reasoning.source,
        })
      }
    }
  }
  return {
    providers,
    models,
    reasoningLevels: OFFERED_REASONING_LEVELS,
    contextPresets: CONTEXT_PRESETS,
    writable: settings !== undefined,
  }
}

/** Append the ops one field change needs, or none when the field is unchanged. */
function fieldOps(ops: SettingsPathOp[], base: readonly string[], field: string, value: number | undefined | null): void {
  if (value === undefined) return
  if (value === null) ops.push({ op: 'unset', path: [...base, field] })
  else ops.push({ op: 'set', path: [...base, field], value })
}

/** The path prefix one model's fields are addressed under in a route. */
function modelFieldBase(provider: string, row: StoredModel, model: string): readonly string[] {
  return row.index === undefined
    ? ['providers', provider, 'modelOverrides', model]
    : ['providers', provider, 'models', String(row.index)]
}

/**
 * Write one tuning edit into the user's Models document.
 *
 * A per-model edit lands in the entry the model already lives in — a `models`
 * entry on a declared route, a `modelOverrides` entry on a catalog route
 * (created on demand). A route-wide edit writes every model the route serves, so
 * a catalog route gains explicit entries rather than only a fallback. Returns
 * the freshly read snapshot, which is what the surface renders next.
 * @param ctx - context carrying the settings and `llm` services.
 * @param input - the edit to apply.
 * @returns the refreshed snapshot.
 * @throws Error when no settings writer is reachable.
 */
export async function writeModelTuning(ctx: Context, input: FreeCodeGoModelTuningWrite): Promise<FreeCodeGoModelTuningSnapshot> {
  const settings = settingsEditor(ctx)
  if (settings === undefined) throw new Error('the Models settings entry is not writable in this composition')
  const llm = llmDirectory(ctx)
  const stored = storedProviders(settings).providers
  const ops: SettingsPathOp[] = []
  const provider = input.provider
  if (provider.trim() === '') throw new Error('a provider route is required')
  if ('applyToModels' in input) {
    const rows = llm === undefined ? [] : await modelRows(llm, stored)
    for (const row of rows.filter(candidate => candidate.provider === provider)) {
      const base = modelFieldBase(provider, row.stored, row.model)
      fieldOps(ops, base, 'contextWindow', input.contextWindow)
      fieldOps(ops, base, 'maxTokens', input.maxOutputTokens)
    }
    if (input.reasoning !== undefined) {
      if (input.reasoning === null) ops.push({ op: 'unset', path: ['providers', provider, 'reasoning'] })
      else ops.push({ op: 'set', path: ['providers', provider, 'reasoning'], value: input.reasoning })
    }
  } else {
    const row = storedModel(maybeRecord(stored[provider]), input.model)
    const base = modelFieldBase(provider, row, input.model)
    fieldOps(ops, base, 'contextWindow', input.contextWindow)
    fieldOps(ops, base, 'maxTokens', input.maxOutputTokens)
    if (input.reasoningLevels !== undefined) {
      if (input.reasoningLevels === null) {
        ops.push({ op: 'set', path: [...base, 'reasoningEfforts'], value: false })
      } else {
        const levels = input.reasoningLevels.filter(level => level !== 'off')
        ops.push({
          op: 'set',
          path: [...base, 'reasoningEfforts'],
          value: levels.length === 0 ? false : reasoningEffortsValue(input.reasoningLevels),
        })
      }
    }
  }
  if (ops.length > 0) await settings.mutate(MODELS_SETTINGS_ENTRY, ops)
  return readModelTuning(ctx)
}
