/**
 * Static third-party Loader-resource conflict detection and opt-in entry disablement.
 *
 * Why the default is off
 * ----------------------
 * The Loader owns entry enablement — its own manager writes it, its own page shows
 * it, and `dsh plugin` addresses it. The Harness's registries (`tools.register`,
 * `commands.register`, the provider maps) already refuse a duplicate with the
 * precise message that names the colliding resource, and a refused `init()` fails
 * that entry alone: the deployment keeps running and the user is told which entry
 * failed and why. Against that, this module decides the same question from a
 * *regex scan of a package's source text*, applies the result by rewriting a
 * Loader entry's `disabled`, and reports it in FreeCodeGo's own panel rather than
 * where the Harness reports a failed entry. That is the plugin taking a decision
 * the Harness owns, on weaker evidence, through a private seam (`init`/`_start`
 * wrapping — a seam the Loader moved once already, in 0.1.6).
 *
 * So it is an override that ships enabled, not a mechanism the deployment has to opt into:
 * with the switch off nothing is intercepted and the Harness's own behaviour is what a
 * deployment gets, and the settings page is one click away from that. With it on, the owner already kept is
 * preserved and the later claimant is disabled before its code runs, which is the
 * one thing the Harness does not offer: a plugin that cannot start is not the same
 * as a plugin that is told why it cannot.
 */

import { createRequire } from 'node:module'
import { readFile, stat } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Entry, EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { FreeCodeGoSettingsPort } from './policy.ts'
import type {
  FreeCodeGoPluginConflictRecord,
  FreeCodeGoPluginConflictResource,
  FreeCodeGoPluginConflictStatus,
} from './types.ts'

const MAX_SOURCE_BYTES = 2_000_000
const MAX_SOURCE_FILES = 50
const MAX_RECORDS = 100
const RESOURCE_NAME = /^[A-Za-z0-9_.:/@-]{1,256}$/
/** Setting name the switch is stored under, in this plugin's own settings document. */
const CONFLICT_PROTECTION_KEY = 'pluginConflictProtectionEnabled'
/**
 * The switch's answer for a guard built with no settings port at all.
 *
 * Off, and deliberately not described as "the default": no deployment lands here. Every shipped
 * mount supplies a port — `index.ts` passes the policy — and that port's document *always*
 * carries this field, because it is a `volatile()` field and schemastery resolves one by taking
 * its schema default when nothing has been written (`Schema.resolve`'s volatile branch wraps the
 * resolved value, which for absent input is `meta.default`). So the document answers `true`
 * before the user ever touches the switch, and this constant describes only a programmatic mount
 * that supplied no document — which is nothing to intercept on behalf of, since interception is
 * this plugin taking a decision the Harness owns.
 */
const NO_SETTINGS_PORT_CONFLICT_PROTECTION = false

type ResourceClaim = {
  readonly resource: FreeCodeGoPluginConflictResource
  readonly resourceName: string
}

type OwnedClaim = ResourceClaim & {
  readonly entryId: string
  /** Loader entry that owns the claim; effective ids may be composite. */
  readonly ownerId: string
  readonly moduleName: string
  /** The owning entry, kept so a claim can be released at runtime rather than only on unload. */
  readonly entry: Entry
}

/**
 * Modules and entry ids this plugin's own bundle patch mounts as stand-ins for a
 * Harness capability that official bundles can also supply: `freecodego/agent-team`
 * and `freecodego/tool-agent-team`, next to the official
 * `@deepseek-ai/dsh-experimental-agent-team` / `-tool-agent-team` pair.
 *
 * They exist for a composition that never selected the official team bundles, and
 * they are the only mounts whose loss cannot cost the deployment a capability:
 * when both are present the official pair is the one it asked for.
 */
const OWN_STAND_IN_MODULES: ReadonlySet<string> = new Set(['freecodego/agent-team', 'freecodego/tool-agent-team'])
const OWN_STAND_IN_ENTRY_IDS: ReadonlySet<string> = new Set(['freecodego-agent-team', 'freecodego-tool-agent-team'])

/** Official Harness packages are published under this scope. */
function isOfficialModuleName(moduleName: string): boolean {
  return moduleName.startsWith('@deepseek-ai/dsh-')
}

/** True when this claim belongs to one of this plugin's own stand-in mounts. 
 * @param moduleName - the module the owning entry imports.
 * @param entryId - the owning entry's effective id, which may be composite.
 * @returns whether the claim is this plugin's own fallback capability.
 */
function isOwnStandIn(moduleName: string, entryId: string): boolean {
  if (OWN_STAND_IN_MODULES.has(moduleName)) return true
  const tail = entryId.slice(entryId.lastIndexOf(':') + 1)
  return OWN_STAND_IN_ENTRY_IDS.has(tail)
}


/**
 * Extract only literal registrations that have a globally exclusive identity.
 * Dynamic registrations are intentionally ignored rather than guessed.
 * @param source - the plugin source text to scan.
 * @returns the resource Claim rows, in backend order.
 */
export function scanPluginResourceClaims(source: string): readonly ResourceClaim[] {
  const claims = new Map<string, ResourceClaim>()
  const add = (resource: FreeCodeGoPluginConflictResource, resourceName: string): void => {
    const normalized = resourceName.trim()
    if (!RESOURCE_NAME.test(normalized)) return
    claims.set(`${resource}:${normalized}`, { resource, resourceName: normalized })
  }
  const addNames = (resource: FreeCodeGoPluginConflictResource, expression: RegExp): void => {
    for (const match of source.matchAll(expression)) add(resource, match[2] ?? '')
  }

  // Registration targets may be aliased (`const t = ctx.tools; t.register(…)`)
  // and a long `description` before `name` can exceed any fixed window, so the
  // receiver is optional and the pre-name window is generous. Matching is
  // anchored on the `name:`/`path:` literal itself with a nearby registration
  // call before it, which keeps false positives low while recovering aliased
  // and long-description registrations that previously went undetected.
  // Name-carrying `register({ name })` calls are classified by *receiver*, in one
  // pass. Two independent generic patterns cannot work here: they would each
  // match the other's call sites, so `ctx.tools.register({name})` was claimed as
  // both a tool and a command. That double claim made two plugins conflict over
  // a name only one of them owned, and the guard would disable the later one.
  //
  // The receiver is deliberately still generic for tools — plugins reach their
  // registry as `ctx.tools`, an alias, or a scoped `childCtx.tools` — while the
  // receivers that carry their own exclusive identity elsewhere are excluded
  // rather than re-classified. The tradeoff is unchanged from before: an
  // unrelated `<x>.register({ name })` on some other registry is still read as a
  // tool, which is the price of recovering aliased registrations.
  for (const match of source.matchAll(/\b((?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*)\.register\s*\(\s*(?:[A-Za-z_$][\w$]*\s*\(\s*)?\{[\s\S]{0,4000}?\bname\s*:\s*(['"])([^'"]+)\2/g)) {
    const last = (match[1] ?? '').split('.').pop() ?? ''
    // Handled by the settings/slot patterns below, which see the real identity.
    if (last === 'settings' || last === 'slots' || last === 'sessionProjections') continue
    add(last === 'commands' ? 'command' : 'tool', match[3] ?? '')
  }
  addNames('settings', /\bsettings\s*\.\s*register\s*\(\s*(['"])([^'"]+)\1\s*,/g)
  addNames('route', /\b[A-Za-z_$][\w$]*\s*\.\s*register\s*\(\s*\{[\s\S]{0,4000}?\bpath\s*:\s*(['"])([^'"]+)\1/g)

  for (const registration of source.matchAll(/\bslots\s*\.\s*register\s*\(\s*\{([\s\S]{0,900}?)\}\s*,/g)) {
    const name = literalProperty(registration[1] ?? '', 'name')
    const id = literalProperty(registration[1] ?? '', 'id')
    if (name !== undefined && id !== undefined) add('slot', `${name}:${id}`)
  }

  for (const adapter of source.matchAll(/\bregisterAdapter\s*\(\s*\[([^\]]*)\]/g)) {
    for (const provider of adapter[1]?.matchAll(/(['"])([^'"]+)\1/g) ?? []) add('provider', provider[2] ?? '')
  }
  return [...claims.values()]
}

/** Automatically prevents newly loaded entries from claiming an active exclusive resource. */
export class FreeCodeGoPluginConflictGuard {
  private readonly claims = new Map<string, OwnedClaim>()
  private readonly sourceClaims = new Map<string, Promise<readonly ResourceClaim[]>>()
  private readonly wrappedEntries = new WeakSet<Entry>()
  private settings: FreeCodeGoSettingsPort | undefined
  private records: readonly FreeCodeGoPluginConflictRecord[]
  private sequence = 0
  private seedTask: Promise<void> | undefined
  private preflightTask = Promise.resolve()
  private started = false
  private interceptionInstalled = false
  private enabled: boolean

  constructor(
    private readonly ctx: Context,
    settings: FreeCodeGoSettingsPort | undefined,
  ) {
    this.settings = settings
    this.records = settings?.get()?.pluginConflictRecords ?? []
    this.enabled = settings?.get()?.[CONFLICT_PROTECTION_KEY] ?? NO_SETTINGS_PORT_CONFLICT_PROTECTION
  }

  /**
   * Install plugin-owned Loader lifecycle wrappers and seed active entry claims.
   *
   * Nothing is intercepted while the switch is off: a wrapper left installed
   * "just in case" would still be this plugin reading every entry's package
   * before it starts, which is the decision the switch is about. `configure`
   * installs the wrappers when the setting is turned on.
   */
  start(): void {
    if (this.started) return
    this.started = true
    this.installInterception()
  }

  /** Wrap every entry's start path, once, and only while the switch is on. */
  private installInterception(): void {
    if (this.interceptionInstalled || !this.protectionEnabled()) return
    this.interceptionInstalled = true
    this.seedTask ??= this.seed()
    this.ctx.effect(() => {
      const disposeEntryInit = this.ctx.on('loader/entry-init', (entry) => {
        this.wrapEntry(entry)
      }, { global: true })
      const disposePartial = this.ctx.on('loader/partial-dispose', (entry) => {
        this.forget(entry.id)
        if (entry.options.group || entry.disabled || entry.fiber === undefined || entry.fiber.uid === null) return
        // Re-claim inside the preflight queue: a synchronous remember would
        // race a concurrent entry's init and let it steal these resource
        // names while the async claims scan is still in flight.
        void this.enqueuePreflight(entry, entry.options).catch(() => undefined)
      }, { global: true })
      return () => {
        disposeEntryInit()
        disposePartial()
      }
    }, 'freecodego: plugin conflict lifecycle guard')
  }

  /** Attach the settings port this guard reads the switch and its records through.
   *
   * The guard is a per-root singleton, so a later mount that carries a port re-points the
   * existing instance at the live document instead of leaving it on the answer it was
   * constructed with.
   * @param settings - the plugin settings port, when one is available.
   */
  configure(settings: FreeCodeGoSettingsPort | undefined): void {
    if (settings === undefined || settings === this.settings) return
    this.settings = settings
    this.enabled = settings.get()?.[CONFLICT_PROTECTION_KEY] ?? NO_SETTINGS_PORT_CONFLICT_PROTECTION
    // The switch may already be on when the settings port arrives: a guard built without one
    // starts with the portless answer, and a later mount can turn it on through `setEnabled`.
    if (this.started) this.installInterception()
    const persisted = settings.get()?.pluginConflictRecords ?? []
    const merged = [...persisted, ...this.records.filter(record => !persisted.some(item => sameConflict(item, record)))].slice(-MAX_RECORDS)
    this.records = merged
    // A settings write can fail (disk full, permissions); losing the merge is
    // preferable to an unhandled rejection crashing the Host.
    if (merged.length !== persisted.length) void settings.update({ pluginConflictRecords: merged }).catch(() => undefined)
  }

  /** Return the browser-safe policy and automatic-repair history. 
   * @returns the plugin Conflict Status.
   */
  snapshot(): FreeCodeGoPluginConflictStatus {
    return {
      pluginConflictProtectionEnabled: this.protectionEnabled(),
      pluginConflictRecords: this.records,
      pluginConflictActiveRecords: this.activeRecordIds(),
    }
  }

  /**
   * The stored records the running tree still matches.
   *
   * History is what makes this necessary. A record is written once and kept, so a
   * boot that followed a live bundle change carries a repair whose polarity the
   * tree has since reversed — the entry it says it stopped is the one running,
   * and the entry it says it kept is the one standing down. Reporting that as a
   * current repair claims the Harness disabled a plugin it is using.
   */
  private activeRecordIds(): readonly string[] {
    const loader = this.ctx.get('loader')
    if (loader === undefined) return []
    const entries = new Map<string, Entry>()
    for (const entry of loader.entries()) entries.set(effectiveEntryId(entry, entry.options), entry)
    return this.records.flatMap((record) => {
      const disabled = entries.get(record.disabledEntryId)
      const kept = entries.get(record.keptEntryId)
      // Both halves have to hold, and the disabled one has to be stopped by its
      // own effective options: that is the state the record describes.
      const stopped = disabled !== undefined && disabled.disabled
      const running = kept !== undefined && kept.fiber !== undefined && kept.fiber.uid !== null
      return stopped && running ? [record.id] : []
    })
  }

  /**
   * The switch as the settings port reports it right now, rather than as it was
   * read when this guard was built: the panel can turn it on or off while the
   * Loader is running, and the running Loader is what the answer acts on.
   */
  private protectionEnabled(): boolean {
    return this.settings?.get()?.pluginConflictProtectionEnabled ?? this.enabled
  }

  /**
   * Persist the global automatic-repair switch, and start or stop acting on it.
   *
   * Recording the value is not enough in the on direction. A guard built while the switch was
   * off never installed its wrappers — that is deliberate, since leaving them in place would
   * keep this plugin reading every entry's package while the deployment had said not to — so a
   * guard that only wrote the new value would report protection as on while the running Loader
   * went on starting every duplicate, and would silently stay inert until the next boot. The
   * install has to come after the write resolves, because the live document is what
   * {@link protectionEnabled} reads back.
   *
   * The off direction needs nothing: the wrappers ask `protectionEnabled()` per entry, so a
   * switch turned off stops the answering without being uninstalled.
   * @param enabled - whether this capability is switched on.
   * @returns the plugin Conflict Status.
   */
  async setEnabled(enabled: boolean): Promise<FreeCodeGoPluginConflictStatus> {
    this.enabled = enabled
    await this.settings?.update({ pluginConflictProtectionEnabled: enabled })
    if (enabled) this.installInterception()
    return this.snapshot()
  }

  private async seed(): Promise<void> {
    const loader = this.ctx.get('loader')
    if (loader === undefined) return
    for (const entry of loader.entries()) {
      this.wrapEntry(entry)
      if (entry.options.group || entry.disabled || entry.fiber === undefined || entry.fiber.uid === null) continue
      await this.remember(entry, entry.options)
    }
  }

  /**
   * The Loader exposes no pre-start policy event, so intercept each entry's
   * lifecycle instead: `init()` is the only start path on Harness 0.1.6, which
   * inlined the private `_start` seam into `_init`. Older loader builds still
   * expose `_start`, so the wrapper keeps covering it when it is there. The
   * wrapper lives in this plugin and leaves the Harness Loader implementation
   * untouched.
   */
  private wrapEntry(entry: Entry): void {
    if (this.wrappedEntries.has(entry)) return
    this.wrappedEntries.add(entry)
    const target = entry as unknown as {
      init: () => Promise<void>
      _start?: (plugin: unknown) => Promise<void>
      options: EntryOptions
      disabled: boolean
    }
    const init = target.init.bind(entry)
    target.init = async (): Promise<void> => {
      await this.preflightBeforeStart(entry, target.options)
      if (target.disabled) return
      await init()
    }
    // Harness 0.1.6 inlined the private `_start` seam into `_init`, so `init()`
    // is the only start path left to intercept; older loader builds still expose
    // `_start`, and wrapping it there keeps replacement updates covered. Binding
    // a missing method used to throw inside `loader/entry-init`, which stopped
    // every entry from starting on the newer loader.
    if (typeof target._start !== 'function') return
    const start = target._start.bind(entry)
    target._start = async (plugin: unknown): Promise<void> => {
      await this.preflightBeforeStart(entry, target.options)
      if (target.disabled) return
      await start(plugin)
    }
  }

  private async preflightBeforeStart(entry: Entry, candidate: EntryOptions): Promise<void> {
    await this.seedTask
    await this.enqueuePreflight(entry, candidate)
  }

  private async preflight(entry: Entry, candidate: EntryOptions): Promise<void> {
    // Off: the Harness's registries decide, and its own error names the resource.
    // Checked before the scan rather than after, so an off switch costs no reads.
    if (!this.protectionEnabled()) return
    if (candidate.group || candidate.disabled) return
    const candidateEntryId = effectiveEntryId(entry, candidate)
    const candidateClaims = await this.claimsFor(entry, candidate)
    const candidateFiles = await this.scannedFilesFor(entry, candidate)
    const conflicts = this.protectionEnabled()
      ? candidateClaims.map(claim => ({ claim, existing: this.claims.get(resourceKey(claim)) }))
        .filter((value): value is { claim: ResourceClaim; existing: OwnedClaim } =>
          value.existing !== undefined
          && value.existing.entryId !== candidateEntryId
          // A package may be mounted more than once with different config
          // (for example spawn and fork subagent tools). Its registrations
          // are intentionally shared and the Loader scopes them per entry;
          // treating the same module as a third-party conflict disables a
          // legitimate capability before it can start.
          && value.existing.moduleName !== candidate.name
          // Two entries whose scanned sources overlap (one entry's claims were
          // read from the other entry's file — the FreeCodeGo bundle pattern:
          // `session-events.js` re-exports `bootstrap.js`) share one physical
          // registration and must not disable each other. Independent plugins
          // in separate files scan disjoint file sets and still conflict.
          && !this.claimsReadFromOverlappingSources(value.existing.entryId, candidateFiles))
      : []

    for (const conflict of conflicts) {
      // Official capability outranks this plugin's stand-in for it. The vendored
      // pair is mounted only for a composition that never selected the official
      // team bundles, and its `!!js` stand-down reads the launch-time bundle
      // list — which a live bundle change leaves stale, so both mount and the
      // claim order, not the intent, decides the winner. Yielding here makes the
      // Harness's own plugin the one that keeps the resource in that window too.
      if (this.yieldsToOfficial(candidate, conflict.existing)) {
        await this.yieldToOfficial(entry, candidate, candidateEntryId, conflict)
        continue
      }
      candidate.disabled = true
      await this.record({
        resource: conflict.claim.resource,
        resourceName: conflict.claim.resourceName,
        disabledEntryId: candidateEntryId,
        disabledModuleName: candidate.name,
        keptEntryId: conflict.existing.entryId,
        keptModuleName: conflict.existing.moduleName,
      })
      return
    }

    this.rememberClaims(entry, candidate, candidateClaims)
    this.resolvedScannedFiles.set(candidateEntryId, new Set(candidateFiles))
  }

  /** Whether the Harness's own module should take a resource from this plugin's stand-in.
   * @param candidate - options of the entry whose start was intercepted.
   * @param existing - the active claim the candidate duplicates.
   * @returns true when the candidate is official and the holder is our own fallback.
   */
  private yieldsToOfficial(candidate: EntryOptions, existing: OwnedClaim): boolean {
    return isOfficialModuleName(candidate.name) && isOwnStandIn(existing.moduleName, existing.ownerId)
  }

  /**
   * Stop this plugin's own stand-in and hand its resource to the official entry
   * that is starting.
   *
   * `update` is the Loader's own enablement path: it merges the option and unloads
   * the running fiber, so the fallback neither serves the resource nor restarts
   * behind the official mount. Its remaining claims are released with it — a
   * stopped entry holds nothing, and a claim left behind would disable the next
   * third-party plugin that names a resource nothing is serving.
   * @param entry - the Loader entry being started.
   * @param candidate - options of the entry being started.
   * @param candidateEntryId - effective id of the entry being started.
   * @param conflict - the claim and the stand-in that currently holds it.
   */
  private async yieldToOfficial(
    entry: Entry,
    candidate: EntryOptions,
    candidateEntryId: string,
    conflict: { claim: ResourceClaim; existing: OwnedClaim },
  ): Promise<void> {
    if (!conflict.existing.entry.disabled) {
      // A Loader that refuses the update still has an official entry on the same
      // name: this is a best effort, and the recorded repair is what the user reads.
      await conflict.existing.entry.update({ disabled: true }).catch(() => undefined)
    }
    this.forget(conflict.existing.ownerId)
    this.claims.set(resourceKey(conflict.claim), {
      ...conflict.claim,
      entryId: candidateEntryId,
      ownerId: entry.id,
      moduleName: candidate.name,
      entry,
    })
    await this.record({
      resource: conflict.claim.resource,
      resourceName: conflict.claim.resourceName,
      disabledEntryId: conflict.existing.entryId,
      disabledModuleName: conflict.existing.moduleName,
      keptEntryId: candidateEntryId,
      keptModuleName: candidate.name,
      yieldedToOfficial: true,
    })
  }

  private async remember(entry: Entry, options: EntryOptions): Promise<void> {
    this.rememberClaims(entry, options, await this.claimsFor(entry, options))
    const effectiveId = effectiveEntryId(entry, options)
    this.resolvedScannedFiles.set(effectiveId, new Set(await this.scannedFilesFor(entry, options)))
  }

  private rememberClaims(entry: Entry, options: EntryOptions, claims: readonly ResourceClaim[]): void {
    const entryId = effectiveEntryId(entry, options)
    for (const claim of claims) {
      const key = resourceKey(claim)
      if (!this.claims.has(key)) this.claims.set(key, { ...claim, entryId, ownerId: entry.id, moduleName: options.name, entry })
    }
  }

  private claimsFor(entry: Entry, options: EntryOptions): Promise<readonly ResourceClaim[]> {
    const sourceKey = `${entry.context.baseUrl ?? ''}\u0000${options.name}`
    const cached = this.sourceClaims.get(sourceKey)
    if (cached !== undefined) return cached
    const task = this.readSources(entry, options.name)
      .then(result => scanPluginResourceClaims(result.sources), () => undefined)
      .then((claims) => {
        // A failed read must not be cached as "no claims" forever: a transient
        // EBUSY/EMFILE during early startup would blind conflict detection for
        // the module until the Host restarts. Only successful scans stay
        // memoized; failures evict so the next claim check retries.
        if (claims === undefined) {
          this.sourceClaims.delete(sourceKey)
          return [] as readonly ResourceClaim[]
        }
        return claims
      })
    this.sourceClaims.set(sourceKey, task)
    return task
  }

  /** Set of files whose source was scanned for one module's claims. Two entries
   * whose scanned file sets overlap claim the same registrations from the same
   * physical source, which is intentional composition — not a conflict. */
  private readonly scannedFiles = new Map<string, Promise<ReadonlySet<string>>>()

  private scannedFilesFor(entry: Entry, options: EntryOptions): Promise<ReadonlySet<string>> {
    const sourceKey = `${entry.context.baseUrl ?? ''}\u0000${options.name}`
    const cached = this.scannedFiles.get(sourceKey)
    if (cached !== undefined) return cached
    const task = this.readSources(entry, options.name)
      .then(result => result.files, () => new Set<string>())
    this.scannedFiles.set(sourceKey, task)
    return task
  }

  private async readSources(entry: Entry, moduleName: string): Promise<{ sources: string; files: ReadonlySet<string> }> {
    if (moduleName.startsWith('cordis:')) return { sources: '', files: new Set<string>() }
    const resolver = createRequire(entry.context.baseUrl ?? import.meta.url)
    const filename = resolver.resolve(moduleName)
    const visited = new Set<string>()
    const sources: string[] = []
    let totalBytes = 0

    const visit = async (current: string): Promise<void> => {
      if (visited.has(current) || visited.size >= MAX_SOURCE_FILES || totalBytes >= MAX_SOURCE_BYTES) return
      visited.add(current)
      // Bound the read by the file size first: one packed bundle could exceed
      // the entire byte budget and would otherwise be loaded fully into memory.
      const info = await stat(current).catch(() => undefined)
      if (info === undefined || !info.isFile() || info.size > MAX_SOURCE_BYTES) return
      const source = await readFile(current, 'utf8')
      totalBytes += Buffer.byteLength(source, 'utf8')
      if (totalBytes > MAX_SOURCE_BYTES) return
      sources.push(source)
      const currentResolver = createRequire(current)
      for (const specifier of relativeModuleSpecifiers(source)) {
        try {
          await visit(currentResolver.resolve(specifier))
        } catch {
          // An optional or non-Node-compatible local import cannot be scanned.
        }
      }
    }

    await visit(filename)
    return { sources: sources.join('\n'), files: visited }
  }

  private async record(input: Omit<FreeCodeGoPluginConflictRecord, 'id' | 'detectedAt'>): Promise<void> {
    // Preflight re-detects the same conflict on every startup; refresh the
    // existing record instead of appending duplicates that flood the history.
    const existing = this.records.find(record => sameConflict(record, { id: '', detectedAt: 0, ...input }))
    if (existing !== undefined) return
    const record: FreeCodeGoPluginConflictRecord = {
      id: `plugin-conflict-${Date.now()}-${++this.sequence}`,
      detectedAt: Date.now(),
      ...input,
    }
    this.records = [...this.records, record].slice(-MAX_RECORDS)
    await this.settings?.update({ pluginConflictRecords: this.records })
  }

  private enqueuePreflight(entry: Entry, candidate: EntryOptions): Promise<void> {
    const task = this.preflightTask.then(() => this.preflight(entry, candidate))
    this.preflightTask = task.catch(() => undefined)
    return task
  }

  private forget(entryId: string): void {
    for (const [key, claim] of this.claims) {
      // Composite effective ids (`${parentEntry.id}:${options.id}`) belong to
      // the owning loader entry too, so partial disposal releases its claims.
      if (claim.ownerId === entryId || claim.entryId === entryId || claim.entryId.startsWith(`${entryId}:`)) this.claims.delete(key)
    }
  }

  /** True when the entry that owns the existing claim and the candidate entry
   * scanned at least one common source file. An overlap means both entries'
   * claim sets were derived from the same physical registration (one file's
   * source was pulled in through the other's relative-import graph), which is
   * shared-source composition inside one package — not a third-party conflict. */
  private claimsReadFromOverlappingSources(existingEntryId: string, candidateFiles: ReadonlySet<string>): boolean {
    if (candidateFiles.size === 0) return false
    const existingFiles = this.resolvedScannedFiles.get(existingEntryId)
    if (existingFiles === undefined) return false
    for (const file of candidateFiles) {
      if (existingFiles.has(file)) return true
    }
    return false
  }

  /** Entry id → scanned file-set snapshot, refreshed when claims are remembered. */
  private readonly resolvedScannedFiles = new Map<string, ReadonlySet<string>>()
}

function resourceKey(value: ResourceClaim): string {
  return `${value.resource}:${value.resourceName}`
}

function effectiveEntryId(entry: Entry, options: EntryOptions): string {
  if (entry.options.id !== undefined) return entry.id
  const parentEntry = entry.parent?.tree.ctx.fiber.entry
  return parentEntry === undefined ? options.id : `${parentEntry.id}:${options.id}`
}

function literalProperty(source: string, property: string): string | undefined {
  const match = source.match(new RegExp(`\\b${property}\\s*:\\s*(['\"])([^'\"]+)\\1`))
  return match?.[2]
}

function relativeModuleSpecifiers(source: string): readonly string[] {
  const specifiers = new Set<string>()
  const add = (expression: RegExp): void => {
    for (const match of source.matchAll(expression)) specifiers.add(match[2] ?? '')
  }
  add(/\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?(['"])(\.{1,2}\/[^'"]+)\1/g)
  add(/\brequire\s*\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g)
  return [...specifiers]
}

function sameConflict(left: FreeCodeGoPluginConflictRecord, right: FreeCodeGoPluginConflictRecord): boolean {
  return left.resource === right.resource
    && left.resourceName === right.resourceName
    && left.disabledEntryId === right.disabledEntryId
    && left.disabledModuleName === right.disabledModuleName
    && left.keptEntryId === right.keptEntryId
    && left.keptModuleName === right.keptModuleName
}

const installedGuards = new WeakMap<Context, FreeCodeGoPluginConflictGuard>()

/**
 * Install (or re-point) this process's conflict guard and start interception when the switch is on.
 *
 * Timing is relative, not absolute. The guard wraps each entry's start path through
 * `loader/entry-init`, so it protects the entries that initialize after it is installed; for the
 * ones already running, {@link FreeCodeGoPluginConflictGuard.seed} wraps them and records the
 * claims they hold, so an entry starting later is still refused a resource an earlier one owns.
 * It does not need to precede the Loader — and cannot, once this plugin is itself a Loader entry —
 * and a deployment whose switch is off intercepts nothing at all.
 * @param ctx - context carrying the services this call reads.
 * @param settings - the Host settings handle the guard reads the switch and records through.
 * @returns the plugin Conflict Guard.
 */
export function installFreeCodeGoPluginConflictGuard(
  ctx: Context,
  settings?: FreeCodeGoSettingsPort,
): FreeCodeGoPluginConflictGuard {
  const root = ctx.root
  let guard = installedGuards.get(root)
  if (guard === undefined) {
    guard = new FreeCodeGoPluginConflictGuard(root, settings)
    installedGuards.set(root, guard)
  } else {
    guard.configure(settings)
  }
  guard.start()
  return guard
}
