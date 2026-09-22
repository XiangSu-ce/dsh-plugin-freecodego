/**
 * The model menu's FreeCodeGo half, answered from the directory this deployment
 * already knows.
 *
 * The wait this removes
 * ---------------------
 * The Host builds its model catalog by asking every registered route for its
 * model list at once, waiting for the slowest answer, and then resolving
 * metadata for every model it got back. Twelve of this deployment's thirteen
 * routes belong to this plugin, and they are the only ones that have to read a
 * network directory to answer: each connector rotates accounts through its own
 * endpoint with a multi-second budget. Measured on 2026-09-22 against a
 * restarted Host, the first catalog took 5528ms and the warm one 12ms — and for
 * those 5.5 seconds the model menu had no provider group to draw, which is what
 * made the picker look like it had not opened at all.
 *
 * What answers instead
 * --------------------
 * One decorator per registered route, in front of the connector's own adapter:
 *
 * - `listModels` answers from the last directory this deployment saw — memory
 *   first, then the snapshot the previous process wrote — and revalidates behind
 *   the answer.
 * - A route with nothing known yet (a first run, or a route added since the
 *   snapshot) is answered within `KNOWN_CATALOG_COLD_ANSWER_MS` rather than
 *   waited on: the read keeps going and its landing announces itself. Waiting is
 *   what let one connector's cold read — or one connector that never answers —
 *   hold the whole menu shut, and an advisory catalog is not worth that. What is
 *   never done is *pretending*: nothing is stored until the read lands, so the
 *   bounded answer never becomes this route's directory. A read that fails inside
 *   the bound still reports its failure, and a recent one is reported again
 *   instead of being re-read, so a provider that is genuinely broken shows an
 *   error rather than an empty group.
 * - `resolveModel` answers from the metadata resolved for that exact model when
 *   its directory was read, so the catalog's per-model pass cannot turn a known
 *   directory back into a network read.
 * - A revalidation that changes a directory announces `llm/adapters-updated` —
 *   the event the model directory, the settings surfaces, and the subagent route
 *   authorization already follow. That is what adds a provider the menu did not
 *   know when it was opened, and what makes a sign-in visible at once instead of
 *   after the route's own cache window.
 * - Everything else (`providerInfo`, retry policy, image pricing, `prepareCall`,
 *   `stream`) delegates, so a turn's own resolution and dispatch still go through
 *   the connector and no request metadata is served from this cache.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/known-provider-catalog
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmImageRequestPricing, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo,
  PreparedAdapterCall, ResolvedRetryPolicy, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { asNumber, asRecord, asString } from './untrusted-json.ts'
import { readJsonFile } from './community-storage.ts'

/**
 * How long a directory answers without a revalidation behind it.
 *
 * Five minutes is shorter than most connectors' own snapshot windows (Kilo's is
 * an hour, WorkBuddy's five minutes) on purpose: this is the point at which the
 * *catalog* refreshes a list it is already showing, not a directory TTL.
 */
export const KNOWN_CATALOG_TTL_MS = 5 * 60_000

/**
 * The oldest snapshot still served.
 *
 * A week-old roster is a far better answer than an empty menu, and the
 * revalidation that starts with it either confirms it or replaces it: what the
 * bound actually prevents is serving a directory from a deployment the user has
 * long moved on from, e.g. a provider they do not use any more.
 */
export const KNOWN_CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60_000

/**
 * Floor between two event-driven revalidations of one route.
 *
 * The wrapper announces on a changed directory and listens for the same event
 * (as does the rest of the plugin), so a change that lands during our own
 * announcement must not start a second read; it also bounds the worst case to
 * one directory read per second per route, whatever an event storm does.
 */
export const KNOWN_CATALOG_REVALIDATE_FLOOR_MS = 1_000

/**
 * How long a route with nothing known waits for its first read before the
 * answer is given without it.
 *
 * This is the budget the model menu is measured against: the Host builds one
 * catalog by asking every route at once and waiting for the slowest, so this is
 * the most a single never-before-read route can add to opening the picker. It is
 * comfortably above the fastest real directory (a connector's own snapshot, tens
 * of milliseconds) and below the multi-second cold reads that made the menu look
 * like it had not opened; the price of exceeding it is a provider group that
 * appears a moment later, which is what the announcement buys back.
 */
export const KNOWN_CATALOG_COLD_ANSWER_MS = 1_500

/**
 * How long a failed first read is reported instead of being retried.
 *
 * A bounded answer would otherwise turn "this provider's directory is broken"
 * into a silently missing group: the failure is remembered for a minute so the
 * next catalog still reports it, and the retry after that is a fresh attempt
 * rather than a re-read on every question.
 */
export const KNOWN_CATALOG_ERROR_TTL_MS = 60_000

/** Snapshot file shape version; a snapshot written by another shape is ignored, never guessed at. */
const SNAPSHOT_VERSION = 1

/** One route's last known directory: the rows, the metadata resolved for them, and when they were read. */
interface KnownRoute {
  readonly models: readonly LlmModelInfo[]
  readonly resolved: ReadonlyMap<string, LlmResolvedModelInfo>
  readonly readAt: number
}

/** Ports the snapshot store needs from its owner: where it lives, how it is written, and who to tell. */
export interface KnownCatalogDirectoryOptions {
  /** Absolute path of the snapshot file, resolved per read and write so a moved home is honored. */
  readonly file: () => string
  /** Persist one snapshot under the owner's tracked-write budget. */
  readonly write: (file: string, value: Record<string, unknown>) => Promise<void>
  /** Announce that a route's directory changed. */
  readonly announce: () => void
}

/**
 * The last directory seen for every route this plugin serves, in memory and in
 * one file under the plugin's state directory.
 *
 * One instance is shared by every registered route, so a Host restart reads the
 * whole model menu's FreeCodeGo half back with a single file read.
 */
export class KnownCatalogDirectory {
  private readonly routes = new Map<string, KnownRoute>()
  private readonly reads = new Map<string, Promise<readonly LlmModelInfo[]>>()
  private readonly failures = new Map<string, { readonly error: unknown; readonly at: number }>()
  private restoreOperation: Promise<void> | undefined
  private persistOperation: Promise<void> | undefined
  private persistDirty = false

  /** @param options - snapshot location, writer, and the announcement port. */
  constructor(private readonly options: KnownCatalogDirectoryOptions) {}

  /**
   * Answer one route's model list, revalidating behind the answer.
   * @param provider - the route being listed.
   * @param inner - the connector adapter that owns it.
   * @returns the rows to serve this caller: the known directory, or the live read when nothing is known.
   */
  async listModels(provider: string, inner: LlmAdapter): Promise<readonly LlmModelInfo[]> {
    await this.restore()
    const known = this.routes.get(provider)
    // Nothing known: bounded, so one route's cold read cannot hold the menu shut.
    if (known === undefined) return await this.coldAnswer(provider, inner)
    if (Date.now() - known.readAt >= KNOWN_CATALOG_TTL_MS) this.revalidate(provider, inner)
    return known.models
  }

  /**
   * Answer a route that has never been read on this machine.
   *
   * The read is started either way and is shared with every other caller; what
   * the budget decides is only whether this caller waits for it. A read that
   * lands inside the bound answers exactly as an awaited one would, a failure
   * inside the bound is reported, and a read that is still open afterwards is
   * left running: nothing is stored, so when it lands it announces a real
   * directory and the next catalog carries the group.
   * @param provider - the route being listed.
   * @param inner - the connector adapter that owns it.
   * @returns the read's rows, or nothing when the budget expired first.
   */
  private async coldAnswer(provider: string, inner: LlmAdapter): Promise<readonly LlmModelInfo[]> {
    const failure = this.recentFailure(provider)
    // A route whose last read failed is reported, not retried into another wait:
    // an advisory catalog that keeps a broken provider invisible is worse than
    // one that names the failure.
    if (failure !== undefined) throw failure
    // Settled on both outcomes so the race can be abandoned without leaving an
    // unhandled rejection behind it.
    const settled = this.read(provider, inner).then(
      rows => ({ kind: 'rows' as const, rows }),
      (error: unknown) => ({ kind: 'failure' as const, error }),
    )
    const raced = await Promise.race([settled, expired(KNOWN_CATALOG_COLD_ANSWER_MS)])
    if (raced === undefined) return []
    if (raced.kind === 'failure') throw raced.error
    return raced.rows
  }

  /**
   * The failure of a recent first read for one route, if there is one.
   * @param provider - the route being listed.
   * @returns the error to report, or undefined when there is nothing recent.
   */
  private recentFailure(provider: string): unknown | undefined {
    const failure = this.failures.get(provider)
    if (failure === undefined) return undefined
    if (Date.now() - failure.at > KNOWN_CATALOG_ERROR_TTL_MS) return undefined
    return failure.error
  }

  /**
   * Answer one exact model's metadata from the directory that listed it.
   * @param provider - the route that owns the model.
   * @param model - exact model id.
   * @param inner - the connector adapter that owns it.
   * @param signal - cancellation forwarded to the connector on a miss.
   * @returns the metadata stored with the directory, or the connector's own answer.
   */
  async resolveModel(
    provider: string,
    model: string,
    inner: LlmAdapter,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    await this.restore()
    const known = this.routes.get(provider)?.resolved.get(model)
    // A model the known directory does not carry is resolved by the connector,
    // which is also what keeps a hand-typed or upstream-new id usable.
    return known ?? await inner.resolveModel(provider, model, signal)
  }

  /**
   * Re-read one route behind whatever is being served.
   *
   * Fire-and-forget by construction: every caller is answering a question with
   * the directory it already has, and a revalidation that fails (offline, signed
   * out, upstream error) simply leaves that answer in place.
   * @param provider - the route to re-read.
   * @param inner - the connector adapter that owns it.
   */
  revalidate(provider: string, inner: LlmAdapter): void {
    const known = this.routes.get(provider)
    if (known !== undefined && Date.now() - known.readAt < KNOWN_CATALOG_REVALIDATE_FLOOR_MS) return
    void this.read(provider, inner).catch(() => undefined)
  }

  /**
   * Read every route whose directory is not known fresh yet.
   *
   * The Host's boot pass: the picker's first catalog arrives once a browser has
   * connected, so a read started here is usually finished long before anyone
   * asks — and a route that is already fresh keeps its snapshot instead of
   * re-reading a directory that was just read.
   *
   * The read is always made through each decorator's own connector: passing this
   * store one of its own decorators as the reader would have that route's read
   * join itself, which is a hang rather than an error. The signature says so.
   *
   * The snapshot is restored *first*: a boot that read every route before looking
   * at the snapshot would put twelve network reads in front of the first menu
   * open, which is the wait this layer exists to remove. What the prewarm is for
   * is the route the snapshot does not have — a provider added since it was
   * written, or a deployment that has never run.
   * @param adapters - the registered decorators, one per route set.
   */
  async prewarm(adapters: Iterable<KnownCatalogAdapter>): Promise<void> {
    await this.restore()
    const now = Date.now()
    for (const adapter of adapters) {
      for (const provider of adapter.routes) {
        const known = this.routes.get(provider)
        if (known !== undefined && now - known.readAt < KNOWN_CATALOG_TTL_MS) continue
        this.revalidate(provider, adapter.connector)
      }
    }
  }

  /** One route's known rows, for tests and diagnostics. */
  knownModels(provider: string): readonly LlmModelInfo[] | undefined {
    return this.routes.get(provider)?.models
  }

  /**
   * Read one route's directory and store it, sharing one in-flight read.
   * @param provider - the route to read.
   * @param inner - the connector adapter that owns it.
   * @returns the fresh rows.
   */
  private read(provider: string, inner: LlmAdapter): Promise<readonly LlmModelInfo[]> {
    const inflight = this.reads.get(provider)
    if (inflight !== undefined) return inflight
    const operation = this.collect(provider, inner)
      .catch((error: unknown) => {
        // Remembered for `coldAnswer`, which reports a broken directory instead
        // of answering it away, and rethrown so an awaiting caller still sees it.
        this.failures.set(provider, { error, at: Date.now() })
        throw error
      })
      .finally(() => {
        if (this.reads.get(provider) === operation) this.reads.delete(provider)
      })
    this.reads.set(provider, operation)
    return operation
  }

  /**
   * Ask the connector for one directory, resolve the metadata its catalog will
   * be asked for, store both, and announce a change.
   * @param provider - the route being read.
   * @param inner - the connector adapter that owns it.
   * @returns the rows this read produced.
   */
  private async collect(provider: string, inner: LlmAdapter): Promise<readonly LlmModelInfo[]> {
    const models = await inner.listModels(provider)
    const resolved = new Map<string, LlmResolvedModelInfo>()
    // The catalog resolves every listed model, so the metadata is gathered here
    // rather than on first sight of each model: by the time the Host asks, its
    // per-model pass has nothing left to read.
    await Promise.all(models.map(async (model) => {
      try {
        resolved.set(model.id, await inner.resolveModel(provider, model.id))
      } catch {
        // A model whose metadata cannot be resolved still lists; that one model
        // is then resolved by the connector, which is where the failure belongs.
      }
    }))
    const previous = this.routes.get(provider)
    this.routes.set(provider, { models, resolved, readAt: Date.now() })
    // A landed read answers the route, so whatever failed before it is history.
    this.failures.delete(provider)
    void this.persist().catch(() => undefined)
    if (!sameDirectory(previous?.models, models)) this.options.announce()
    return models
  }

  /**
   * Write the whole known directory back, one file for every route, as one
   * serialized pass.
   *
   * Serialized because a boot reads every route at once: each landing read wants
   * to persist, and two passes racing on one file can leave the older state —
   * measured on a restarted Host, the slow route's directory was read and known
   * but absent from the snapshot, so the next boot paid for it again. A caller
   * that arrives while a pass is running does not start a second one; it marks
   * the write dirty, and the pass repeats until it has written the newest state.
   * @returns when the newest state has been written.
   */
  private persist(): Promise<void> {
    if (this.persistOperation !== undefined) {
      this.persistDirty = true
      return this.persistOperation
    }
    const operation = (async () => {
      do {
        this.persistDirty = false
        await this.writeSnapshot()
      } while (this.persistDirty)
    })().finally(() => {
      if (this.persistOperation === operation) this.persistOperation = undefined
    })
    this.persistOperation = operation
    return operation
  }

  /** One snapshot write, of the state as it is now. */
  private async writeSnapshot(): Promise<void> {
    const routes: Record<string, unknown> = {}
    for (const [provider, route] of this.routes) {
      routes[provider] = {
        readAt: route.readAt,
        models: route.models,
        resolved: [...route.resolved.values()],
      }
    }
    await this.options.write(this.options.file(), {
      version: SNAPSHOT_VERSION,
      savedAt: Date.now(),
      routes,
    })
  }

  /** Restore the snapshot the previous process left, once per process, shared by every concurrent asker. */
  private restore(): Promise<void> {
    this.restoreOperation ??= this.restoreSnapshot()
    return this.restoreOperation
  }

  /** The one snapshot read, whose callers are served by `restore`. */
  private async restoreSnapshot(): Promise<void> {
    const file = this.options.file()
    const value = await readJsonFile(file)
    if (value.version !== SNAPSHOT_VERSION) return
    const savedAt = asNumber(value.savedAt)
    if (savedAt === undefined || Date.now() - savedAt > KNOWN_CATALOG_MAX_AGE_MS) return
    for (const [provider, entry] of Object.entries(asRecord(value.routes))) {
      const route = restoreRoute(provider, entry)
      if (route !== undefined) this.routes.set(provider, route)
    }
  }
}

/**
 * The adapter every FreeCodeGo route is registered behind: the connector's own
 * answer when the directory is unknown, the known directory otherwise.
 */
export class KnownCatalogAdapter extends LlmAdapter {
  /** The connector adapter this registration serves turns through. */
  readonly connector: LlmAdapter

  /** The routes this registration owns. */
  readonly routes: readonly string[]

  /**
   * @param providers - the routes this adapter owns.
   * @param connector - the connector adapter that serves them.
   * @param directory - the snapshot store shared by every route of this plugin.
   */
  constructor(
    providers: readonly string[],
    connector: LlmAdapter,
    private readonly directory: KnownCatalogDirectory,
  ) {
    super()
    this.routes = [...providers]
    this.connector = connector
  }

  /** Delegate: a route's display name is the connector's own. */
  override providerInfo(provider: string): LlmProviderInfo {
    return this.connector.providerInfo(provider)
  }

  /** Delegate: the connector owns its retry policy. */
  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.connector.providerRetryPolicy(provider)
  }

  /** Delegate: image pricing is read synchronously by the token meter and is the connector's own. */
  override imageRequestPricing(provider: string, model: string): LlmImageRequestPricing | undefined {
    return this.connector.imageRequestPricing(provider, model)
  }

  /** Answer from the known directory, revalidating behind it. */
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.directory.listModels(provider, this.connector)
  }

  /** Answer from the metadata resolved with that directory. */
  override resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return this.directory.resolveModel(provider, model, this.connector, signal)
  }

  /** Delegate: a turn's own resolution and dispatch stay the connector's. */
  override prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return this.connector.prepareCall(provider, model, signal)
  }

  /** Delegate: streaming is the connector's transport. */
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.connector.stream(options)
  }

  /** Re-read every route of this registration behind what it serves (a provider-topology change). */
  revalidate(): void {
    for (const provider of this.routes) this.directory.revalidate(provider, this.connector)
  }
}

/**
 * Rebuild one route from its snapshot entry, or nothing when any part of it
 * cannot be trusted.
 *
 * Rows are taken as the connector produced them (the Host strips what it does
 * not know), but the fields the Host *does* validate are checked here, because a
 * catalog that violates them fails the whole provider group rather than the one
 * row: a model list and a resolved metadata set that do not match this shape are
 * dropped so the connector answers instead.
 * @param provider - the route key the entry was stored under.
 * @param entry - the stored route value.
 * @returns the restored route, or undefined when the entry is not usable.
 */
function restoreRoute(provider: string, entry: unknown): KnownRoute | undefined {
  const value = asRecord(entry)
  const readAt = asNumber(value.readAt)
  if (readAt === undefined || !Array.isArray(value.models)) return undefined
  const models = value.models.filter((model): model is LlmModelInfo => isModelRow(provider, model))
  if (models.length !== value.models.length) return undefined
  const resolved = new Map<string, LlmResolvedModelInfo>()
  for (const item of Array.isArray(value.resolved) ? value.resolved : []) {
    const row = restoreResolved(provider, item)
    if (row !== undefined) resolved.set(row.id, row)
  }
  return { models, resolved, readAt }
}

/** Whether one stored row is a model entry the Host's catalog will accept for this route. */
function isModelRow(provider: string, item: unknown): boolean {
  const row = asRecord(item)
  return asString(row.provider) === provider && nonEmpty(row.id) && nonEmpty(row.name)
}

/**
 * One restored resolved-metadata entry, checked against the fields the Host
 * validates before the connector is asked instead.
 * @param provider - the route the entry belongs to.
 * @param item - the stored value.
 * @returns the entry, or undefined when it is not usable.
 */
function restoreResolved(provider: string, item: unknown): LlmResolvedModelInfo | undefined {
  const row = asRecord(item)
  if (asString(row.provider) !== provider || !nonEmpty(row.id) || !nonEmpty(row.name)) return undefined
  if (row.context !== undefined && asNumber(asRecord(row.context).contextWindow) === undefined) return undefined
  if (row.defaultMaxTokens !== undefined && asNumber(row.defaultMaxTokens) === undefined) return undefined
  if (row.reasoning !== undefined) {
    const reasoning = asRecord(row.reasoning)
    if (!Array.isArray(reasoning.efforts) || !reasoning.efforts.every((effort: unknown) => {
      const level = asRecord(effort)
      return nonEmpty(level.id) && nonEmpty(level.name)
    })) return undefined
  }
  if (row.systemPromptUpdate !== undefined && typeof row.systemPromptUpdate !== 'object') return undefined
  // The row was produced by the connector, so it is carried through as-is: only
  // the Host-validated shape above earns that trust.
  return row as unknown as LlmResolvedModelInfo
}

/** Whether a value is a non-empty string. */
function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * A promise that resolves to nothing once the budget is spent, so a race against
 * a read can time it out without a second mechanism to cancel.
 * @param ms - the budget in milliseconds.
 * @returns a promise that settles when the budget is spent.
 */
function expired(ms: number): Promise<undefined> {
  return new Promise<undefined>((resolve) => { setTimeout(() => { resolve(undefined) }, ms) })
}

/**
 * Whether two directories are the same list.
 *
 * The comparison is the rows themselves, in order: what the menu shows is
 * exactly this value, so a change in any field it renders has to reach the
 * announcement, and an availability flip across an account's cooldown is a
 * change the picker draws.
 * @param previous - the directory served before this read.
 * @param next - the directory just read.
 * @returns whether nothing the catalog renders changed.
 */
function sameDirectory(previous: readonly LlmModelInfo[] | undefined, next: readonly LlmModelInfo[]): boolean {
  return previous !== undefined && JSON.stringify(previous) === JSON.stringify(next)
}
