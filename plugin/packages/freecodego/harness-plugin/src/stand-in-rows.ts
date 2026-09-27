/**
 * Keep this composition's capabilities while the official rows that supply them
 * are not the ones serving — and hand the capability over the moment they are.
 *
 * Four rows do that, and they are the third kind of mount this bundle carries.
 * Beside the rows that supply something no upstream bundle mounts at all
 * (`freecodego/subagent-codex`, `freecodego/subagent-claude-code`: upstream's own
 * packages that no composition can otherwise select) and the rows that are plainly
 * this plugin's own (its tools, its settings, its UI), these four are upstream
 * modules compiled into this payload *and* available as an official row elsewhere
 * — `freecodego/auto-review` beside `@deepseek-ai/dsh-experimental-auto-review`,
 * the two subagent providers beside `@deepseek-ai/dsh-subagent-codex` and
 * `-claude-code`, and `freecodego/tool-session-query` beside
 * `@deepseek-ai/dsh-tool-session-query`. Each stands down through a `!!js` expression whose fallback is
 * `profileContext.startedBundles`, a **launch-time** fact: it answers "was the
 * official package selected", never "is it mounted", and it does not move when a
 * bundle is switched on at runtime.
 *
 * The team pair (`freecodego/agent-team`, `freecodego/tool-agent-team`) used to be
 * arbitrated here too, and it is gone rather than repaired: both rows were copies
 * of upstream modules that the official `…agent-team-profile` bundle mounts **by
 * name**, so there was a mounted original for every composition that could ever
 * have wanted one. Arbitrating the copy was work created entirely by shipping it.
 * What is left keeps each row for a reason the team pair did not have: the
 * Auto-review bundle is selected by no profile this plugin ships, and neither
 * subagent package is mounted by any upstream bundle.
 *
 * Those are not the same question, and the gap runs both ways.
 *
 * **Too little.** A host that cannot supply `@deepseek-ai/dsh-experimental-auto-review`
 * (a packaged runtime that omitted it, say) accepts the selection, fails to import
 * the official layer's row, and reports it as `did not activate`. The selection
 * predicate had already stood this plugin's row down, so the deployment ends up
 * with *neither* gate. {@link reconcileStandIns} is that repair: this bundle's own
 * row comes back when the official one is not serving.
 *
 * **Too much.** Enable the official bundle while the process runs — the plugin
 * panel's switch — and `startedBundles` still names the bundle list the process
 * launched with, so this bundle's rows are **already serving** when the official
 * rows arrive. The official row then cannot start at all: what it registers is
 * taken. Measured on the real Loader, through the panel's own operation with the
 * team pair, which behaved identically:
 *
 *     Error: service "agentTeams" has been registered at <TeamService>
 *     dsh: warning: 3 entries did not activate
 *     agent-team (...): failed to import
 *
 * — which the panel shows as 启用失败, and which leaves the user with this plugin's
 * fallback instead of the Harness's own capability they asked for. So the handover
 * is the other half: {@link handOverToOfficialInit} stops this bundle's row, and
 * **awaits its disposal**, before the official row's import runs. Awaiting is the
 * requirement rather than a detail — the Loader disposes a disabled entry's fiber
 * without awaiting it, and that disposal is what releases the name.
 *
 * Official-first decides every ordering here: the Harness's own plugin is the one
 * that keeps the resource, in the live window as well as at boot. This bundle's
 * rows are the fallback, and a fallback that wins a race is not a fallback.
 *
 * A live window needs a live answer, so the patch predicate asks this plugin first
 * ({@link OFFICIAL_ROW_SERVICE}, provided by {@link installStandInWatch}) and
 * keeps the launch-time list as its fallback. The handover alone was not enough:
 * the write that stands a row down is the Loader's own `disabled` option, which the
 * profile recomposition re-applies from the patch — measured as this bundle's row
 * restarting against the official provider that was already serving. Asked live, the
 * re-applied predicate answers `true` and the Loader takes its own stand-down path.
 * @module
 */

import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Context } from '@deepseek-ai/cordis'
import { disabledState } from './loader-entry-state.ts'

/**
 * The official module that supplies a capability, and this bundle's row for it.
 *
 * Every one of them carries a stand-in: the team pair, which had one entry
 * spelled `undefined` to record that this bundle ships no client-side team UI, is
 * deleted along with its rows, and the official client-side team surface needs no
 * entry here because nothing in this bundle stands in for it.
 *
 * The pairing is what makes each case tractable. The Auto-review bundle is an
 * official row this plugin can hand over to and take back from; the two subagent
 * packages are upstream's own, mounted by no upstream bundle, so a composition
 * without these rows cannot select `codex` or `claude-code` in `spawn_teammate` at
 * all; and the session-history tools are the same kind of gap on the tool surface
 * — no bundle mounts them and the install contract does not carry them. In every
 * case a composition that mounts the official package itself keeps it.
 */
export const OFFICIAL_FALLBACK_COVERAGE: ReadonlyMap<string, string> = new Map([
  ['@deepseek-ai/dsh-experimental-auto-review', 'freecodego/auto-review'],
  ['@deepseek-ai/dsh-subagent-codex', 'freecodego/subagent-codex'],
  ['@deepseek-ai/dsh-subagent-claude-code', 'freecodego/subagent-claude-code'],
  ['@deepseek-ai/dsh-tool-session-query', 'freecodego/tool-session-query'],
])

/**
 * This plugin's stand-in module, mapped to the official module that supplies the
 * same capability. The two names are the bundle patch's own rows
 * (`bundle-latest/cordis.patch.yml`), which is where the pairing is declared.
 *
 * Every pair that can hand over, which is every entry of
 * {@link OFFICIAL_FALLBACK_COVERAGE}. That is deliberate even though two questions
 * are answered from it — which mount to hand over *to*, and which mounts the
 * conflict guard may silently stand down in favour of an official one — because a
 * pair missing from here is a pair nothing arbitrates, which is how the Auto-review
 * switch collided before it was listed.
 */
export const STAND_IN_MODULES: ReadonlyMap<string, string> = new Map([
  ['freecodego/auto-review', '@deepseek-ai/dsh-experimental-auto-review'],
  // The session-history tools. This one is on by default rather than standing down
  // by default, which is the difference the capability itself makes: the base
  // mounts the services it injects but nothing mounts the tool package, so a
  // deployment that installs the official package is opting in to its own copy
  // rather than replacing a capability it already had.
  ['freecodego/tool-session-query', '@deepseek-ai/dsh-tool-session-query'],
  // The two cross-engine subagent providers. A composition that mounts the
  // official package itself is the one that keeps the provider name — the pair
  // registers `codex` and `claude-code` on `ctx.subagents`, and the registry
  // rejects a second registration of a name, so this is the same arbitration the
  // three rows above need rather than a different kind of it.
  ['freecodego/subagent-codex', '@deepseek-ai/dsh-subagent-codex'],
  ['freecodego/subagent-claude-code', '@deepseek-ai/dsh-subagent-claude-code'],
])

/**
 * The service this bundle's rows ask, through the patch's own predicate, whether the
 * official layer is really holding the capability.
 *
 * The predicate it backs is the one the patch writes, and the reason it has to exist
 * is that the predicate's own launch-time answer is not just stale — it is
 * *unstable*. Measured on the web Host, with the team pair that has since been
 * deleted: the handover stood this bundle's `freecodego-agent-team` row down for the
 * official one, the profile recomposition then re-applied the patch row over that
 * write (which is the Loader's own `disabled` option, so nothing about it is ours to
 * keep) and restarted the row against the official provider that was already serving.
 * The result was a registration collision thrown by *this* bundle's row, a row left
 * failed in the tree, and a `did not activate` warning on every enable. The same
 * recomposition runs for the rows that remain.
 *
 * Answering this question from the running tree instead is what makes that
 * recomposition come out right: re-applied while the official row serves, the
 * predicate reads `true`, so the Loader runs its own stand-down path
 * (`fiber?.dispose()` and return) rather than importing the stand-in again. The
 * expression keeps the launch-time answer as its fallback, so a composition
 * without this plugin — and this plugin's own rows before it mounts — behaves
 * exactly as before.
 */
export const OFFICIAL_ROW_SERVICE = 'freecodegoOfficialRows'

/** Official module to the stand-in it takes over from, for the pairs that can hand over. */
const OFFICIAL_TAKES_OVER: ReadonlyMap<string, string> = new Map(
  [...STAND_IN_MODULES].map(([standIn, official]) => [official, standIn]),
)

/**
 * Stand-ins this pass stopped for an official row, so the reverse decision can be
 * recognised later. A `disabled` write leaves the option as a plain boolean, which
 * is also what a settings toggle writes, so the option cannot carry this — only the
 * fact that this module stopped it can. Keyed by entry id: one process may host
 * several Loaders (the test scaffolding does), and an id is unique within each.
 */
const handedOver = new Set<string>()

/** The Loader entry surface this reconciliation reads and corrects. */
export interface StandInEntry {
  readonly id: string
  readonly options: {
    readonly id?: string | undefined
    readonly name: string
    readonly disabled?: unknown
  }
  /** True when this entry or an owning parent is disabled; throws when the expression does. */
  readonly disabled: boolean
  /** Present once the entry's module has been imported; `uid` is null before it starts. */
  readonly fiber?: { readonly uid: unknown; await?: () => Promise<unknown> } | undefined
  /** The in-flight `init()`, cleared by the Loader when it settles — either way. */
  readonly _initTask?: unknown
  /** The Loader's start path, which this module wraps for an official row it must hand over to. */
  init?: () => Promise<void>
  /**
   * The import-and-start step `init()` publishes as `_initTask`, which is the seam
   * this module prefers: a wrapper on `init` hides the row from `loader.await()`.
   */
  _init?: () => Promise<void>
  update(options: { readonly disabled: boolean }): Promise<unknown>
}

/**
 * What stopping a stand-in needs from a Loader row, and no more.
 *
 * Narrow on purpose: the conflict guard calls {@link standDownStandIn} with the
 * `Entry` it already holds, and a Loader `Entry` carries private members, so a
 * wider parameter type would force a cast that hides the fields this actually reads.
 */
export interface StandInStopTarget {
  readonly id: string
  /** Present once the entry's module has been imported; `uid` is null before it starts. */
  readonly fiber?: { readonly uid: unknown; await?: () => Promise<unknown> } | undefined
  update(options: { readonly disabled: boolean }): Promise<unknown>
}

/** The slice of the Loader service this reconciliation needs. */
export interface StandInLoader {
  entries(): Iterable<StandInEntry>
  await(): Promise<unknown>
}

/** Whether an entry is running: enabled, imported, and past its start. */
function isServing(entry: StandInEntry): boolean {
  return disabledState(entry) === false && entry.fiber !== undefined && entry.fiber.uid !== null
}

/**
 * Whether an entry's `disabled` option is still one of the bundle patch's stand-downs.
 *
 * Two things have to hold, and each rules out a different mistake. The option has
 * to be a compiled `!!js` expression — the form the Loader keeps for such a row,
 * since its own `disabledOf` reads `options.disabled.__jsExpr` — which is how this
 * stand-down is told apart from the plain `disabled: true` a settings toggle or a
 * later layer writes. And the expression has to be one of this plugin's own
 * predicates, of which the patch carries both halves: {@link OFFICIAL_ROW_SERVICE}
 * for the live answer, and the launched bundle list for the composition that has no
 * plugin to ask. Anything else is left alone, however it reads: re-enabling a
 * deployment's own expression would be this plugin overruling it, which is a worse
 * failure than the one being repaired.
 * @param value - the entry's `disabled` option.
 * @returns whether the option is one of the patch's own stand-down predicates.
 */
function isSelectionExpression(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const expression = (value as { readonly __jsExpr?: unknown }).__jsExpr
  return typeof expression === 'string'
    && (expression.includes(OFFICIAL_ROW_SERVICE)
      // The launch-time-only form: the predicate the patch carried before
      // {@link OFFICIAL_ROW_SERVICE} existed, which a composition without this
      // plugin still evaluates. Recognised by naming one of the official modules
      // this bundle still stands in for, so deleting a pair above also stops this
      // from matching a row nobody stands in for any more.
      || (expression.includes('startedBundles')
        && [...STAND_IN_MODULES.values()].some(official => expression.includes(official))))
}

/**
 * Stop a stand-in and wait until it has let go of everything it registered.
 *
 * The fiber decides, not the `disabled` option. A serving row's option is the
 * patch layer's launch-time `!!js` expression, which a live bundle change leaves
 * answering the wrong way — measured on the real Loader, a row was serving with
 * `disabled` reading `true` and, in the other direction, the panel's own enable
 * left the expression reading `false` while the row's fiber held the name. Only
 * `fiber.uid !== null` means "this row is the one holding the capability", and it
 * is what both arbiters — this handover and the conflict guard's yield — key on.
 *
 * The await is the requirement rather than a detail. `Entry.update` disposes a
 * disabled entry's fiber *without awaiting it* and returns; the registration is
 * released by that disposal, so an official row that starts in between still
 * collides on the name. The caller's official row therefore runs only after the
 * capability is genuinely free.
 * @param entry - the stand-in row to stop.
 * @returns whether a serving stand-in was stopped and had let go.
 */
export async function standDownStandIn(entry: StandInStopTarget): Promise<boolean> {
  const fiber = entry.fiber
  // `uid` nulled is the Loader's own statement that a row serves nothing: either it
  // never started, or an earlier pass already took it down and waited for it.
  if (fiber === undefined || fiber.uid === null) return false
  try {
    await entry.update({ disabled: true })
  } catch {
    // The Loader already logged why; an official row that goes on to collide will
    // report that collision, which is more informative than this failure.
    return false
  }
  handedOver.add(entry.id)
  try {
    await fiber.await?.()
  } catch {
    // A fiber whose start failed still released what it had registered.
  }
  return true
}

/**
 * Stop this bundle's stand-in for `moduleName` and wait until it has let go.
 *
 * Called from the official row's own start path, so the return value is a
 * statement about the Loader's state rather than a best effort: by the time the
 * official `init()` runs, the name it registers is free.
 * @param loader - the running Loader service.
 * @param moduleName - this bundle's stand-in module to stop.
 * @returns whether a serving stand-in was stopped.
 */
async function handOverStandIn(loader: StandInLoader, moduleName: string): Promise<boolean> {
  const standIn = [...loader.entries()].find(entry => entry.options.name === moduleName)
  if (standIn === undefined) return false
  return await standDownStandIn(standIn)
}

/**
 * Whether the Loader is still importing this entry's module.
 *
 * `init()` clears `_initTask` when it settles, and a settled import has either set
 * a fiber or left none — so "no fiber and no task" is the Loader's own statement
 * that this row is not going to serve. Anything else is a state the reverse pass
 * must not act on: an import still running may be about to succeed.
 * @param entry - the Loader entry to read.
 * @returns whether an import or lifecycle task is in flight for it.
 */
function importInFlight(entry: StandInEntry): boolean {
  return entry._initTask !== undefined
}

/** Rows whose start path this module already wrapped. */
const wrappedRows = new WeakSet<StandInEntry>()

/**
 * Wrap a row's start so this bundle's stand-in is down before an official row runs.
 *
 * The Loader offers no pre-start hook, so the row's own start step is the seam —
 * the same one the conflict guard uses, and for the same reason. Which row is
 * official cannot be decided here: `loader/entry-init` is emitted from the `Entry`
 * constructor, *before* the Loader assigns `options`, so this handler sees every
 * new row with `options` still empty. Measured on the real Loader, asking the
 * module name at this point matched nothing, no row was ever wrapped, and the
 * official `agent-team` row collided on this bundle's service exactly as before.
 * The question is therefore asked when it can be answered — inside the step, where
 * the name is set — and the wrap is unconditional and free: one map lookup per
 * start.
 *
 * The step wrapped is the private `_init` rather than `init`, which is a
 * correctness question rather than a style one: `Entry.init()` publishes its start
 * as `_initTask`, and the panel's own reconcile audits the tree — including the
 * rows it just enabled — right after `loader.await()`. A wrapper installed on
 * `init` is invisible to that read, so the audit ran while this handover was still
 * awaiting and reported the rows the user had just switched on as
 * `failed to import`. A Loader exposing only `init` falls back to it, which is
 * what the conflict guard reports the collision for.
 * @param entry - the entry the Loader just created.
 * @param loader - the running Loader service.
 */
function handOverToOfficialInit(entry: StandInEntry, loader: StandInLoader): void {
  if (wrappedRows.has(entry)) return
  wrappedRows.add(entry)
  const standIn = (): string | undefined => OFFICIAL_TAKES_OVER.get(entry.options.name)
  if (typeof entry._init === 'function') {
    const step = entry._init.bind(entry)
    entry._init = async (): Promise<void> => {
      const moduleName = standIn()
      if (moduleName !== undefined) await handOverStandIn(loader, moduleName)
      await step()
    }
    return
  }
  if (typeof entry.init !== 'function') return
  const init = entry.init.bind(entry)
  entry.init = async (): Promise<void> => {
    const moduleName = standIn()
    if (moduleName !== undefined) await handOverStandIn(loader, moduleName)
    await init()
  }
}

/**
 * Bring back every stand-in whose official counterpart is not running.
 *
 * Two repairs, one per way a row can be out of service while the capability is this
 * bundle's to carry: a row the predicate or a handover stopped, which needs its
 * option cleared, and a row that is enabled but serving nothing — what a live switch
 * back off leaves behind, which needs its start. Idempotent by construction: a row
 * that is serving, or whose start is in flight, is skipped before either repair, so
 * re-running on every entry start cannot loop.
 * @param loader - the running Loader service.
 * @returns the entry ids this pass restarted, for a caller that logs.
 */
export async function reconcileStandIns(loader: StandInLoader): Promise<readonly string[]> {
  // One pass, materialized: the Loader's `entries()` is a generator, so walking
  // it twice would repair nothing on the second walk.
  const entries = [...loader.entries()]
  const officialNames = new Set(STAND_IN_MODULES.values())
  // Two official states both mean "leave this bundle's row down". A counterpart
  // that serves is the provider the deployment asked for; a counterpart whose
  // start is still in flight is about to be. Restoring the stand-in against the
  // second was measured on the real Host: this bundle's own row came back a second
  // after the handover had taken it down, threw `service "agentTeams" has been
  // registered` at the official row that was already serving, and left itself in a
  // failed state in the tree the user reads. Only a counterpart that is absent, or
  // that has settled with nothing registered (the install that cannot import the
  // official module), leaves the capability to this bundle.
  const officialHeld = new Set(entries
    .filter(entry => officialNames.has(entry.options.name) && (isServing(entry) || importInFlight(entry)))
    .map(entry => entry.options.name))
  const restarted: string[] = []
  for (const entry of entries) {
    const official = STAND_IN_MODULES.get(entry.options.name)
    // Only this plugin's own rows, and only while this module's own decision is what
    // stopped them: the patch's stand-down predicate, or the handover this module
    // performed. A row whose state cannot be read is left alone for the same reason a
    // user's `disabled: true` is — this pass repairs its own decisions and no one
    // else's.
    if (official === undefined) continue
    if (!isSelectionExpression(entry.options.disabled) && !handedOver.has(entry.id)) continue
    if (officialHeld.has(official)) continue
    // Serving already, or on its way there: nothing to repair either way.
    if (entry.fiber !== undefined && entry.fiber.uid !== null) continue
    if (importInFlight(entry)) continue
    const state = disabledState(entry)
    // Stopped, and the capability is ours again: clear the stand-down and let the
    // Loader's own enablement path start the row.
    if (state === true) {
      try {
        await entry.update({ disabled: false })
      } catch {
        // The Loader already logged why this row could not start; carrying on is
        // what lets the *other* stand-in still come back.
        continue
      }
      handedOver.delete(entry.id)
      restarted.push(entry.options.id ?? entry.options.name)
      continue
    }
    // Enabled and yet serving nothing, which is the state a live switch *back off*
    // leaves behind: the handover took this row down while the official one held the
    // capability, the official rows have now left the tree, and the predicate that
    // stood this row down answers `false` again — but the profile recomposition does
    // not restart a row whose declared options it considers unchanged. Measured on
    // the web Host as the panel's own `启用失败` on the *disable* click:
    // `freecodego-agent-team (freecodego/agent-team): fiber state 4`. `undefined` — an
    // expression this install cannot evaluate — is not a state to act on either.
    if (state !== false) continue
    try {
      await entry.init?.()
    } catch {
      continue
    }
    handedOver.delete(entry.id)
    restarted.push(entry.options.id ?? entry.options.name)
  }
  return restarted
}

/**
 * Whether an official row for `moduleName` is serving, or is on its way to serving.
 *
 * Answers the question {@link OFFICIAL_ROW_SERVICE} is provided for, and never
 * throws: the caller is a patch expression the Loader evaluates while reading a
 * row's `disabled`, where a throw is reported as a broken row of its own. An
 * unreadable row is not a provider, so it answers `false` and this bundle's own row
 * stays the one holding the capability.
 * @param loader - the running Loader service, when this context can see it.
 * @param moduleName - the official module whose row is asked about.
 * @returns whether the official provider is here or arriving.
 */
export function officialRowHolds(loader: StandInLoader | undefined, moduleName: string): boolean {
  if (loader === undefined) return false
  try {
    for (const entry of loader.entries()) {
      if (entry.options.name !== moduleName) continue
      if (isServing(entry) || importInFlight(entry)) return true
    }
  } catch {
    return false
  }
  return false
}

/**
 * The running Loader, or `undefined` when this context cannot see it.
 *
 * Three sources, in the order of how much of the Loader's contract each relies on,
 * because one source is not enough: measured on the web Host, `ctx.get('loader')`
 * answered `undefined` from this plugin's context while the Loader was running and
 * serving every other row. The whole reconciliation then did nothing — no handover,
 * no fallback — and the panel reported the switch as 启用失败 with the official
 * rows colliding on this bundle's own service. The Loader owns this plugin's row and
 * the row carries the Loader, so that is the source that cannot fail on a mount the
 * Loader itself performed.
 * @param ctx - the plugin context to resolve the Loader from.
 * @returns the Loader service, when one is reachable.
 */
function resolveLoader(ctx: Context): StandInLoader | undefined {
  const named = ctx.get('loader') as StandInLoader | undefined
  if (named !== undefined) return named
  const fiber = (ctx as unknown as { readonly fiber?: { readonly entry?: { readonly loader?: StandInLoader } } }).fiber
  return fiber?.entry?.loader
}

/** The Loader an entry belongs to, which is how a `loader/*` payload names it. */
function loaderOfEntry(entry: unknown): StandInLoader | undefined {
  return (entry as { readonly loader?: StandInLoader } | undefined)?.loader
}

/**
 * Reconcile at startup and after every entry start and stop.
 *
 * Every moment matters. The startup pass is what brings this bundle's provider up
 * on an install whose official rows cannot run; the per-entry passes cover the
 * other direction — a live bundle change that adds the official layer, or unloads
 * it, lands long after boot — and the handover wrapped onto an official row's start
 * is what keeps the official side able to start at all.
 * @param ctx - the plugin context whose Loader service is watched.
 */
export function installStandInWatch(ctx: Context): void {
  // Resolved once up front for the startup pass, and again from every event payload:
  // a row always knows its Loader, so the watch survives a context that cannot name
  // the service at all.
  let loader = resolveLoader(ctx)
  // Provided before the startup pass, because the rows that ask through it are
  // siblings mounted by the same patch list and the first composition is the one
  // that decides whether this bundle's rows mount at all.
  const disposeService = ctx.provide(OFFICIAL_ROW_SERVICE, {
    holds: (moduleName: string): boolean => officialRowHolds(loader, moduleName),
  })
  const run = (): void => {
    const current = loader
    if (current === undefined) return
    void current.await().then(async () => {
      const restored = await reconcileStandIns(current)
      // A restart of this bundle's own provider is worth a line: what the user sees
      // otherwise is the official layer's failed rows and no capability, which reads
      // as this plugin's fault.
      if (restored.length) {
        ctx.logger.warn(`freecodego: the official modules these rows stand in for did not mount in this install, so the bundle's own rows were re-enabled (${restored.join(', ')})`)
      }
    }).catch(() => undefined)
  }
  ctx.effect(() => {
    const disposeEntryInit = ctx.on('loader/entry-init', (entry) => {
      loader ??= loaderOfEntry(entry)
      const current = loader
      if (current === undefined) return
      // The event carries the Loader's own `Entry`, whose start seam is private in
      // that declaration; this read of it is exactly what
      // {@link handOverToOfficialInit} exists to do.
      handOverToOfficialInit(entry as unknown as StandInEntry, current)
      run()
    }, { global: true })
    // A row leaving the tree — the official bundle switched back off — is the other
    // way the answer changes, and it is not a start: without this the fallback
    // would stay down until the next boot.
    const disposePartial = ctx.on('loader/partial-dispose', (entry) => {
      loader ??= loaderOfEntry(entry)
      run()
    }, { global: true })
    return () => {
      disposeEntryInit()
      disposePartial()
    }
  }, 'freecodego: stand-in row reconciliation')
  ctx.effect(() => disposeService, 'freecodego: official row queries')
  run()
}
