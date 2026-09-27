import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  installStandInWatch,
  reconcileStandIns,
  type StandInEntry,
  type StandInLoader,
} from '../src/stand-in-rows.ts'
import { provideHostServiceAs } from './support/host-services.ts'

type Row = StandInEntry

/**
 * A fake row is a real one with the fields a test has to move: `disabled` follows
 * its own `update`, `restores` records what was asked for, and both may be told to
 * throw instead, which is what the Loader does for an entry whose expression or
 * module it could not resolve.
 */
interface FakeRow extends Omit<Row, 'disabled' | 'fiber'> {
  readonly restores: number[]
  /** Starts this row's module, as the Loader does; a test calls it to run a wrapped start. */
  readonly starts: number[]
  readonly throwOnDisabled: boolean
  readonly disabledThrows: boolean
  throwOnUpdate: boolean
  disabled: boolean
  /** The stopped row's fiber object, still in place with `uid` nulled, as the Loader leaves it. */
  fiber?: { uid: unknown; await?: () => Promise<unknown> } | undefined
  /** The Loader's in-flight `init()`, which a test sets to mean "still importing". */
  _initTask?: unknown
}

/**
 * The compiled form the Loader keeps for a `!!js` option — the predicate the bundle
 * patch writes.
 *
 * Both forms the patch carries are exercised across this file, because they are the
 * two things {@link isSelectionExpression} recognises: the live answer, asked of the
 * service this plugin provides (`freecodegoOfficialRows`), and the launch-time
 * bundle list that is that answer's fallback for a composition not mounting this
 * plugin. A stand-in that only matched one of them would be left down forever on
 * installs whose patch row carries the other.
 */
const livePredicate = { __jsExpr: "ctx.get('freecodegoOfficialRows')?.holds('@deepseek-ai/dsh-subagent-codex') ?? false" }
const launchPredicate = { __jsExpr: "ctx.get('freecodegoOfficialRows')?.holds('@deepseek-ai/dsh-experimental-auto-review') ?? ctx.get('profileContext')?.startedBundles?.includes('@deepseek-ai/dsh-experimental-auto-review') ?? false" }

/** This bundle's Auto-review row, and the official module that supplies the same gate. */
const AUTO_REVIEW_STAND_IN = 'freecodego/auto-review'
const AUTO_REVIEW_OFFICIAL = '@deepseek-ai/dsh-experimental-auto-review'
/** This bundle's cross-engine providers, and the official packages that would supply them. */
const CODEX_STAND_IN = 'freecodego/subagent-codex'
const CODEX_OFFICIAL = '@deepseek-ai/dsh-subagent-codex'
const CLAUDE_STAND_IN = 'freecodego/subagent-claude-code'
const CLAUDE_OFFICIAL = '@deepseek-ai/dsh-subagent-claude-code'

/**
 * One Loader row, as the runtime reports it: the `disabled` option a patch layer
 * wrote, the resolved disabled state, and the fiber that only exists once the
 * module imported.
 */
function row(over: {
  readonly id: string
  readonly name: string
  readonly disabled?: unknown
  readonly fiber?: { readonly uid: unknown; await?: () => Promise<unknown> } | undefined
  readonly disabledThrows?: boolean
  readonly updateThrows?: boolean
  readonly importInFlight?: boolean
  /**
   * What the row's `disabled` option currently answers, when that differs from the
   * option's own shape — a `!!js` predicate that flips to `false` once the official
   * rows it asks about leave the tree is exactly the state a live switch produces.
   */
  readonly disabledReads?: boolean
}): FakeRow {
  const restores: number[] = []
  const state: { disabled: boolean } = {
    // The Loader resolves a `!!js` option before it reports the state; a written
    // expression object is therefore a disabled row, not a truthy one — unless the test
    // says what that expression answers right now.
    disabled: over.disabledReads ?? (over.disabled !== undefined && over.disabled !== false),
  }
  const starts: number[] = []
  const self: FakeRow = {
    id: over.id,
    options: { id: over.id, name: over.name, ...(over.disabled === undefined ? {} : { disabled: over.disabled }) },
    restores,
    starts,
    init: async () => { starts.push(1) },
    throwOnDisabled: over.disabledThrows === true,
    disabledThrows: over.disabledThrows === true,
    throwOnUpdate: over.updateThrows === true,
    ...(over.importInFlight === true ? { _initTask: Promise.resolve() } : {}),
    get disabled(): boolean {
      if (this.throwOnDisabled) throw new Error(`${over.id}: the disabled expression could not be evaluated`)
      return state.disabled
    },
    set disabled(next: boolean) { state.disabled = next },
    fiber: over.fiber,
    update: async (next) => {
      if (self.throwOnUpdate) throw new Error(`${over.id}: the module could not be imported`)
      restores.push(next.disabled ? 1 : 0)
      state.disabled = next.disabled
      // The Loader disposes a stopped row's fiber without awaiting it and leaves the
      // object in place with `uid` nulled — that is what "the name is free again"
      // looks like to every later pass. A fake that kept its `uid` would report a
      // stopped row as still serving, which is the opposite of the truth.
      if (next.disabled && self.fiber !== undefined && self.fiber.uid !== null) self.fiber = { ...self.fiber, uid: null }
    },
  }
  return self
}

const loaderOf = (...rows: FakeRow[]): StandInLoader => ({
  // The Loader's own `entries()` is a generator over the tree: one call is one
  // pass. A fake handing back an array would be re-iterable, and would hide the
  // bug of walking it twice — once for the serving official rows and once to
  // repair this plugin's — where the second walk is empty.
  *entries() { yield* rows },
  await: async () => undefined,
})

describe('reconcileStandIns', () => {
  it('restores a stand-in the bundle selection stood down when the official module never imported', async () => {
    // The desktop case: the profile selected the official bundle, so this plugin's
    // pair stood down on a launch-time fact. The official rows were created and
    // their import failed, so the composition ended up with no provider at all.
    const standIn = row({
      id: CODEX_STAND_IN,
      name: CODEX_STAND_IN,
      disabled: livePredicate,
    })
    const official = row({
      id: 'subagent-codex',
      name: CODEX_OFFICIAL,
      disabled: false,
      fiber: undefined,
    })

    await expect(reconcileStandIns(loaderOf(official, standIn))).resolves.toEqual([CODEX_STAND_IN])
    expect(standIn.restores).toEqual([0])
    // The official row is not this plugin's to touch, whatever its state.
    expect(official.restores).toEqual([])
  })

  it('counts an official row whose own expression throws as not running', async () => {
    // An install that cannot supply what the official row's expression names makes
    // reading that row throw. app-boot reports such a row as an entry failure, so it
    // is no more a provider than one whose import failed — and one unreadable row
    // must not stop the rest of the tree from being repaired.
    const standIn = row({ id: CODEX_STAND_IN, name: CODEX_STAND_IN, disabled: livePredicate })
    const second = row({ id: CLAUDE_STAND_IN, name: CLAUDE_STAND_IN, disabled: livePredicate })
    const official = row({
      id: 'subagent-codex',
      name: CODEX_OFFICIAL,
      disabled: false,
      fiber: { uid: 7 },
      disabledThrows: true,
    })

    await expect(reconcileStandIns(loaderOf(official, standIn, second)))
      .resolves.toEqual([CODEX_STAND_IN, CLAUDE_STAND_IN])
  })

  it('still brings the other stand-in back when one of them cannot start', async () => {
    // Two rows, two capabilities. A row that cannot start is a reason to log, not a
    // reason to leave the second capability missing behind it.
    const first = row({ id: CODEX_STAND_IN, name: CODEX_STAND_IN, disabled: livePredicate, updateThrows: true })
    const second = row({ id: CLAUDE_STAND_IN, name: CLAUDE_STAND_IN, disabled: livePredicate })

    await expect(reconcileStandIns(loaderOf(first, second))).resolves.toEqual([CLAUDE_STAND_IN])
    expect(second.restores).toEqual([0])
  })

  it('leaves a stand-in that is already running alone', async () => {
    // A real boot showed the Loader rewriting the option from the patch layer after
    // a repair, so a row can read `disabled` while its fiber is live and serving.
    // The fiber is the proof the capability is there; re-updating that row would
    // only churn a lifecycle that already works.
    const standIn = row({
      id: AUTO_REVIEW_STAND_IN,
      name: AUTO_REVIEW_STAND_IN,
      disabled: launchPredicate,
      fiber: { uid: 380 },
    })

    await expect(reconcileStandIns(loaderOf(standIn))).resolves.toEqual([])
    expect(standIn.restores).toEqual([])
  })

  it('starts the stand-in again when the official rows have left and the predicate answers false', async () => {
    // Switching the official bundle back off: the predicate that stood this row down
    // answers `false` again, but the profile recomposition does not restart a row whose
    // declared options it considers unchanged. On the web Host the panel reported its
    // own 启用失败 on the disable click — `fiber state 4` — and the capability was left
    // with no provider at all.
    const standIn = row({
      id: AUTO_REVIEW_STAND_IN,
      name: AUTO_REVIEW_STAND_IN,
      disabled: launchPredicate,
      disabledReads: false,
      fiber: { uid: null },
    })

    await expect(reconcileStandIns(loaderOf(standIn))).resolves.toEqual([AUTO_REVIEW_STAND_IN])
    expect(standIn.starts).toEqual([1])
    // The row is enabled already; the repair is the start, not another option write.
    expect(standIn.restores).toEqual([])
  })

  it('leaves an enabled stand-in that is still starting alone', async () => {
    // The same repair must not race a start already in flight: a second `init()` is
    // only a duplicate, and the import is the expensive half.
    const standIn = row({
      id: CODEX_STAND_IN,
      name: CODEX_STAND_IN,
      disabled: livePredicate,
      disabledReads: false,
      fiber: undefined,
      importInFlight: true,
    })

    await expect(reconcileStandIns(loaderOf(standIn))).resolves.toEqual([])
    expect(standIn.starts).toEqual([])
  })

  it('leaves the stand-in down while the official row is still starting', async () => {
    // The measured race: this bundle's row came back a second after the handover had
    // taken it down, threw at the official row that was already serving, and left
    // itself failed in the tree the user reads. An official row whose import is still
    // in flight is about to be the provider, so the fallback stays down until that
    // start settles one way or the other.
    const standIn = row({ id: CODEX_STAND_IN, name: CODEX_STAND_IN, disabled: livePredicate })
    const official = row({
      id: 'subagent-codex',
      name: CODEX_OFFICIAL,
      disabled: false,
      fiber: undefined,
      importInFlight: true,
    })

    await expect(reconcileStandIns(loaderOf(official, standIn))).resolves.toEqual([])
    expect(standIn.restores).toEqual([])
  })

  it('leaves the stand-in down while the official provider is running', async () => {
    const standIn = row({ id: CLAUDE_STAND_IN, name: CLAUDE_STAND_IN, disabled: livePredicate })
    const official = row({
      id: 'subagent-claude-code',
      name: CLAUDE_OFFICIAL,
      disabled: false,
      fiber: { uid: 1 },
    })

    await expect(reconcileStandIns(loaderOf(official, standIn))).resolves.toEqual([])
    expect(standIn.restores).toEqual([])
  })

  it('counts an official row that has not started as not running', async () => {
    // A created-but-unstarted entry has a fiber with no uid: it has not registered
    // anything, so the fallback is the only provider the tree has.
    const standIn = row({ id: AUTO_REVIEW_STAND_IN, name: AUTO_REVIEW_STAND_IN, disabled: launchPredicate })
    const official = row({ id: 'auto-review', name: AUTO_REVIEW_OFFICIAL, disabled: false, fiber: { uid: null } })

    await expect(reconcileStandIns(loaderOf(official, standIn))).resolves.toEqual([AUTO_REVIEW_STAND_IN])
  })

  it('respects a stand-in the user stopped instead of the selection predicate', async () => {
    // `disabled: true` is a later layer's or the user's own decision. Re-enabling it
    // would be this plugin overruling the deployment it is running in.
    const standIn = row({ id: AUTO_REVIEW_STAND_IN, name: AUTO_REVIEW_STAND_IN, disabled: true })

    await expect(reconcileStandIns(loaderOf(standIn))).resolves.toEqual([])
    expect(standIn.restores).toEqual([])
  })

  it('respects a `!!js` expression someone else wrote', async () => {
    // Only the bundle patch's own predicate is this plugin's to undo. A compiled
    // expression about anything else is a deployment's decision, and re-enabling it
    // would be worse than the missing capability this pass exists to repair.
    const standIn = row({
      id: AUTO_REVIEW_STAND_IN,
      name: AUTO_REVIEW_STAND_IN,
      disabled: { __jsExpr: "ctx.get('policy')?.reviewRuntime !== 'freecodego'" },
    })

    await expect(reconcileStandIns(loaderOf(standIn))).resolves.toEqual([])
    expect(standIn.restores).toEqual([])
  })

  it('leaves a stand-in whose own expression throws alone', async () => {
    // The same rule as a user's expression, for the same reason: a row whose state
    // cannot be read is not one this pass may overrule.
    const standIn = row({ id: AUTO_REVIEW_STAND_IN, name: AUTO_REVIEW_STAND_IN, disabledThrows: true })

    await expect(reconcileStandIns(loaderOf(standIn))).resolves.toEqual([])
    expect(standIn.restores).toEqual([])
  })

  it('leaves a serving stand-in and every unrelated entry alone', async () => {
    const standIn = row({ id: AUTO_REVIEW_STAND_IN, name: AUTO_REVIEW_STAND_IN, disabled: false })
    const unrelated = row({ id: 'auto-review', name: AUTO_REVIEW_OFFICIAL, disabled: false, fiber: undefined })

    await expect(reconcileStandIns(loaderOf(standIn, unrelated))).resolves.toEqual([])
    expect(standIn.restores).toEqual([])
    expect(unrelated.restores).toEqual([])
  })

  it('treats the launch-time half of the patch predicate as its own and the other half too', async () => {
    // Both forms the patch writes are this plugin's decision to undo: the live answer
    // (`freecodegoOfficialRows.holds`) on the rows that ask it, and the launched
    // bundle list that the same predicate falls back to for a composition without
    // this plugin. Recognising one and not the other leaves a row down forever on
    // whichever patch form it carries.
    const byService = row({ id: CODEX_STAND_IN, name: CODEX_STAND_IN, disabled: livePredicate })
    const byBundle = row({ id: AUTO_REVIEW_STAND_IN, name: AUTO_REVIEW_STAND_IN, disabled: launchPredicate })

    await expect(reconcileStandIns(loaderOf(byService, byBundle)))
      .resolves.toEqual([CODEX_STAND_IN, AUTO_REVIEW_STAND_IN])
  })
})

describe('handing over to the official row', () => {
  it('stops this bundle\'s stand-in, and awaits its disposal, before the official row starts', async () => {
    // The measured failure this exists for: the panel enables the official bundle
    // while this bundle's row is serving, the official row registers the name that
    // row already holds, and it never starts — which the panel reports as 启用失败.
    const order: string[] = []
    const standIn = row({
      id: CODEX_STAND_IN,
      name: CODEX_STAND_IN,
      disabled: false,
      fiber: { uid: 380, await: async () => { order.push('disposed') } },
    })
    const official = row({ id: 'subagent-codex', name: CODEX_OFFICIAL, disabled: false, fiber: undefined })
    const ctx = new Context()
    try {
      provideHostServiceAs<StandInLoader>(ctx, 'loader', loaderOf(standIn, official))
      await ctx.plugin({
        name: 'stand-in-handover-test',
        apply(inner: Context) { installStandInWatch(inner) },
      })
      // The Loader created the official row; its start path is now this module's.
      const loaderEvents = ctx as unknown as { emit(event: 'loader/entry-init', payload: unknown): void }
      loaderEvents.emit('loader/entry-init', official)

      // What the Loader does when the tree settles: start the row.
      await official.init?.()

      expect(standIn.restores).toEqual([1])
      // The disposal is awaited, so the official start is the last thing to happen.
      expect(order).toEqual(['disposed'])
      expect(official.starts).toEqual([1])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('passes a row it has no stand-in for straight through to the Loader', async () => {
    // Every row is wrapped, because the wrap is decided when `loader/entry-init` fires —
    // from the `Entry` constructor, before the Loader assigns `options`, so the module
    // name is not readable yet. The wrap is therefore transparent for the rows this
    // bundle carries no counterpart for: a lookup that matches nothing, then the row's
    // own start, unchanged. `ui-agent-team` is the live example — the official
    // client-side team surface is supplied by its own bundle and has no fallback here.
    const official = row({ id: 'ui-agent-team', name: '@deepseek-ai/dsh-experimental-client-ui-agent-team', disabled: false })
    const ctx = new Context()
    try {
      provideHostServiceAs<StandInLoader>(ctx, 'loader', loaderOf(official))
      await ctx.plugin({
        name: 'stand-in-client-test',
        apply(inner: Context) { installStandInWatch(inner) },
      })
      const loaderEvents = ctx as unknown as { emit(event: 'loader/entry-init', payload: unknown): void }
      loaderEvents.emit('loader/entry-init', official)
      await official.init?.()
      // The row started, and started once: the wrap around a row with no counterpart
      // neither blocks it nor runs it twice.
      expect(official.starts).toEqual([1])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('installStandInWatch', () => {
  it('reconciles at startup and again after an entry starts, without looping', async () => {
    // The desktop case: the selection predicate stood this bundle's row down and the
    // official row never imported, so the process has no provider until this pass.
    const standIn = row({ id: CODEX_STAND_IN, name: CODEX_STAND_IN, disabled: livePredicate })
    const official = row({ id: 'subagent-codex', name: CODEX_OFFICIAL, disabled: false, fiber: undefined })
    let awaits = 0
    const loader: StandInLoader = {
      *entries() { yield official; yield standIn },
      await: async () => { awaits += 1 },
    }
    const ctx = new Context()
    try {
      // On the root, which is where the Harness mounts its own Loader: a service
      // provided inside `apply` is not visible to the plugin that provided it.
      provideHostServiceAs<StandInLoader>(ctx, 'loader', loader)
      await ctx.plugin({
        name: 'stand-in-watch-test',
        apply(inner: Context) { installStandInWatch(inner) },
      })
      await vi.waitFor(() => { expect(standIn.restores).toEqual([0]) })
      // The startup pass is deferred behind `loader.await()`, so the tree it reads
      // is the settled one rather than the entries mid-import.
      expect(awaits).toBeGreaterThan(0)

      // A later start — a live bundle change that adds or unloads the official
      // layer — is the other moment the answer can change.
      const loaderEvents = ctx as unknown as { emit(event: 'loader/entry-init' | 'loader/partial-dispose', payload: unknown): void }
      loaderEvents.emit('loader/entry-init', official)
      await vi.waitFor(() => { expect(awaits).toBeGreaterThan(1) })
      // Idempotent: the restored row is serving, so the second pass changes nothing.
      expect(standIn.restores).toEqual([0])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('brings a handed-over stand-in back once the official row is gone', async () => {
    // The other half of the handover: switching the official bundle off again must
    // restore the capability this bundle was carrying, not leave the process with
    // neither provider.
    const standIn = row({
      id: CLAUDE_STAND_IN,
      name: CLAUDE_STAND_IN,
      disabled: false,
      fiber: { uid: 380, await: async () => undefined },
    })
    const official = row({ id: 'subagent-claude-code', name: CLAUDE_OFFICIAL, disabled: false, fiber: undefined })
    const present = [standIn, official]
    const loader: StandInLoader = {
      *entries() { yield* present },
      await: async () => undefined,
    }
    const ctx = new Context()
    try {
      provideHostServiceAs<StandInLoader>(ctx, 'loader', loader)
      await ctx.plugin({
        name: 'stand-in-restore-test',
        apply(inner: Context) { installStandInWatch(inner) },
      })
      const loaderEvents = ctx as unknown as { emit(event: 'loader/entry-init' | 'loader/partial-dispose', payload: unknown): void }
      loaderEvents.emit('loader/entry-init', official)
      await official.init?.()
      expect(standIn.restores).toEqual([1])

      // The official bundle is switched off: its row leaves the tree.
      present.splice(0, present.length, standIn)
      loaderEvents.emit('loader/partial-dispose', official)
      await vi.waitFor(() => { expect(standIn.restores).toEqual([1, 0]) })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
