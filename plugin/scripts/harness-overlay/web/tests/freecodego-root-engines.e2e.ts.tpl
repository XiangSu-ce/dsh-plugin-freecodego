// Web e2e scenario: the four root-engine paths this plugin serves beside the
// Harness, exercised through the real booted Host rather than through the router's
// own unit seam.
//
// Why this file exists
// --------------------
// Root engine selection has no upstream counterpart. No Harness release declares a
// root-engine seam, the official `@deepseek-ai/dsh-subagent-codex` / `-claude-code`
// packages are one-shot *subagent* providers that cannot open a root Session, and
// the only way this plugin can serve a root Session on another engine is by
// replacing the private `ctx.agents` factory slot in place
// (`agent-engine-router.ts`). Every one of those facts belongs to another package,
// so an upstream update can move any of them without touching a line of this
// repository — and the failure mode is the user's, not ours: a picker row that
// opens nothing, or a Host that dies with `no agent factory registered`.
//
// `harness-plugin/tests/upstream-seam-contracts.spec.ts` pins the *text* of those
// seams. This file pins the *behaviour*, end to end, on a real Host: whatever the
// upstream shape becomes, these four paths have to keep answering the same way.
//
// How the engine is selected
// --------------------------
// The way the product selects one: `setDefaultEngine` persists the picker's choice
// and the next Session takes it through the ordinary default route. That is the
// path the settings surface actually drives — not a per-session engine field — so a
// regression that only broke the persisted-default route would otherwise pass.
//
// The four paths, and what each one has to do
// -------------------------------------------
// - `deepseek` (the stand-down path): the router hands the Session to the official
//   `@deepseek-ai/dsh-agent-loop` factory and records `adapter-loop` on the log.
//   This is the path a foreign engine must never be able to break, because it is
//   the one every default Session takes.
// - `codex` and `claude`: the picker persists the choice and the router admits the
//   Session on the native runtime, or the picker refuses the choice with that
//   engine's *own* reason (`install Codex before selecting it`). Both halves are
//   asserted, because which one applies depends on whether the artifact is
//   installed, and neither is allowed to be any other kind of error — a Host-level
//   `no agent factory registered`, a registry collision, or a Session left
//   half-open are all drift. A refusal also has to leave the previous engine
//   selected and the engine path usable, which is asserted with it.
// - 让位 (handover): the official optional bundle is enabled live, which is the one
//   window where this bundle's stand-in rows and the Harness's own rows meet. The
//   root-engine path must be untouched by it — the handover takes down subagent
//   rows, and a root Session opened around it must still be the deepseek path.
//
// The hermetic home this scaffold boots under (`scaffold.ts` pins `$DSH_HOME` to a
// temp directory for the whole lifetime) carries no runtime artifact, so on a
// clean machine the two native paths answer with their documented refusals. On a
// machine that does have an artifact installed the same assertions pass with the
// native branch, which is why both are written rather than just the refusal.
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

const FREECODEGO_BUNDLE = fileURLToPath(new URL('../../../packages/freecodego/bundle-latest', import.meta.url))

/** The official Team bundle, whose live enable is the 让位 window. */
const OFFICIAL_TEAM_BUNDLE = '@deepseek-ai/dsh-experimental-agent-team-profile'

/**
 * The plugin-owned services this scenario reaches by name.
 *
 * Declared here rather than imported: `packages/freecodego/**` is excluded from the
 * host program (`tsconfig.host.json` checks those packages through their own
 * configs), so the plugin's `Context` augmentation is not in scope for a web e2e.
 * The two shapes below are the whole contract this file reads, which keeps the cast
 * honest — a rename on the plugin side fails one narrowed interface here instead of
 * silently widening an `any`.
 */
interface EngineDirectory {
  readonly defaultEngine: string
  readonly engines: readonly {
    readonly id: string
    readonly availability: string
    readonly reasons: readonly string[]
    readonly draining: boolean
  }[]
}

interface FreeCodeGoHost {
  freeCodeGoHarness: {
    catalog(): EngineDirectory
    setDefaultEngine(engine: 'deepseek' | 'codex' | 'claude'): Promise<{ readonly engine: string }>
  }
  pluginManager: {
    setBundleEnabled(bundle: string, enabled: boolean): Promise<{ error?: string }>
  }
}

/** The plugin-owned services, reached by name through the settled context. */
function pluginHost(scaffold: WebScaffold): FreeCodeGoHost {
  return scaffold.ctx as unknown as FreeCodeGoHost
}

/** One root Session's outcome, as the engine path left it. */
interface OpenedRoot {
  /** The executor recorded on the Session log, when a Session opened. */
  readonly executor: string | undefined
  readonly engineId: string | undefined
  readonly provider: string | undefined
  /** The rejection message, when the engine refused the Session. */
  readonly error: string | undefined
}

/**
 * Persist `engine` as the picker's choice, which is the product's own selection
 * route: the next Session takes it through the ordinary default route and the
 * router decides.
 *
 * A refusal is *returned* rather than thrown, and it is a real answer: the picker's
 * guard rejects an engine whose runtime is not installed before it writes anything,
 * so the persisted default survives and the next Session is still the previous
 * engine's. Which of the two happens depends on whether the artifact is installed,
 * so both are asserted.
 * @param scaffold - the booted Host.
 * @param engine - the engine the picker is asked for.
 * @returns the refusal message, or `undefined` when the choice was persisted.
 */
async function selectRootEngine(
  scaffold: WebScaffold,
  engine: 'deepseek' | 'codex' | 'claude',
): Promise<string | undefined> {
  try {
    const persisted = await pluginHost(scaffold).freeCodeGoHarness.setDefaultEngine(engine)
    // The picker reads its own write back, so a silently-ignored choice is caught
    // here rather than showing up as a Session on the wrong engine.
    if (persisted.engine !== engine) throw new Error(`setDefaultEngine(${engine}) persisted ${persisted.engine}`)
    return undefined
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Open one root Session on the engine the picker is currently set to, and report
 * what the engine path decided.
 *
 * The executor is read off the Session's own `freecodego/engine-executor` event
 * rather than off the router's return value: that event is the durable fact the
 * resume path reads the engine back from, so it is the one that has to be right.
 * @param scaffold - the booted Host.
 * @param sessionId - the Session id to create (one bench per assertion).
 * @returns what the Session recorded, or the rejection message.
 */
async function openRootSession(scaffold: WebScaffold, sessionId: string): Promise<OpenedRoot> {
  let handle: Awaited<ReturnType<WebScaffold['ctx']['agents']['create']>>
  try {
    handle = await scaffold.ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd: scaffold.workspaceCwd },
      agentOptions: scaffold.ctx.agentDefaultModel.currentSelection(),
    })
  } catch (error: unknown) {
    return {
      executor: undefined,
      engineId: undefined,
      provider: undefined,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  try {
    // Widened to the two fields this reads: the event union is a `declare module`
    // merge owned by the plugin, which the host program does not include.
    const events = handle.agent.session.snapshotEvents() as readonly { readonly type: string, readonly data?: unknown }[]
    const data = events.find(event => event.type === 'freecodego/engine-executor')?.data as
      { readonly executor?: string, readonly engineId?: string, readonly provider?: string } | undefined
    return {
      executor: data?.executor,
      engineId: data?.engineId,
      provider: data?.provider,
      error: undefined,
    }
  } finally {
    await handle.dispose()
  }
}

describe('web e2e: root engine paths beside the Harness', () => {
  let scaffold: WebScaffold
  let bench = 0

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      profile: { packages: [{ dir: FREECODEGO_BUNDLE, enabled: true }] },
    })
  }, 180_000)

  afterAll(async () => {
    await scaffold?.close().catch(() => undefined)
  })

  it('lists all three engines in the picker directory, whatever their install state', () => {
    // The directory is what the settings surface renders, so an engine that stops
    // being listed is a picker row that silently disappears after an update. Each
    // row also has to carry a definite availability: `updating` would mean the
    // router never settled, which is a boot failure hiding as a state.
    const directory = pluginHost(scaffold).freeCodeGoHarness.catalog()
    expect(directory.engines.map(engine => engine.id)).toEqual(['freecodego', 'codex', 'claude'])
    for (const engine of directory.engines) {
      expect(['available', 'unavailable'], `${engine.id} must settle on a definite availability`).toContain(engine.availability)
      expect(engine.draining, `${engine.id} must not be left draining`).toBe(false)
      // An unavailable row has to say why, and the reason has to be the engine's
      // own refusal code rather than a generic one — that code is what the picker
      // shows the user and what this plugin's install flow acts on.
      if (engine.availability === 'unavailable') {
        expect(engine.reasons.length, `${engine.id} must carry its refusal reason`).toBeGreaterThan(0)
      }
    }
  })

  it('opens a deepseek root Session on the official loop — the stand-down path', async () => {
    expect(await selectRootEngine(scaffold, 'deepseek'), 'deepseek is always selectable').toBeUndefined()
    const opened = await openRootSession(scaffold, `root-engine-deepseek-${String(bench++)}`)
    // The official loop is the whole point of this path: a native engine must never
    // be able to capture a Session that asked for neither.
    expect(opened.error, 'a deepseek Session must always open').toBeUndefined()
    expect(opened.engineId).toBe('deepseek')
    expect(opened.executor).toBe('adapter-loop')
  })

  it('selects or refuses the Codex engine with that engine\'s own answer', async () => {
    // Pin the starting point first, so the assertion below is about the refusal and
    // not about whatever the previous case left behind.
    expect(await selectRootEngine(scaffold, 'deepseek')).toBeUndefined()
    const refused = await selectRootEngine(scaffold, 'codex')
    if (refused === undefined) {
      const opened = await openRootSession(scaffold, `root-engine-codex-${String(bench++)}`)
      expect(opened.error, 'a selected codex engine must open a Session').toBeUndefined()
      expect(opened.engineId).toBe('codex')
      expect(opened.executor).toBe('native')
      // The route the engine itself runs on, not the caller's label: `codex` is
      // `defaultProviderForEngine('codex')`, and the durable binding records it.
      expect(opened.provider).toBe('codex')
      return
    }
    // No artifact under this hermetic home, so the picker refuses — and the refusal
    // is the engine's own code, not a generic error. Anything else here (a Host-level
    // factory failure, a registry collision) is upstream drift.
    expect(refused).toMatch(/CODEX_RUNTIME_NOT_INSTALLED/)
    // The guard runs before anything is written, so the previous choice survives: a
    // refused pick must not strand the user on an engine that cannot start.
    const directory = pluginHost(scaffold).freeCodeGoHarness.catalog()
    expect(directory.defaultEngine, 'a refused pick must not change the persisted engine').toBe('freecodego')
    const row = directory.engines.find(engine => engine.id === 'codex')
    expect(row?.availability).toBe('unavailable')
    expect(row?.reasons.length, 'the codex row must still say why it is unavailable').toBeGreaterThan(0)
    // And the path itself still works: a refused pick must not leave the engine
    // registry or the replaced factory slot in a state a Session cannot open from.
    const opened = await openRootSession(scaffold, `root-engine-codex-refused-${String(bench++)}`)
    expect(opened.error, 'the stand-down path must survive a refused pick').toBeUndefined()
    expect(opened.executor).toBe('adapter-loop')
  })

  it('selects or refuses the Claude engine with that engine\'s own answer', async () => {
    expect(await selectRootEngine(scaffold, 'deepseek')).toBeUndefined()
    const refused = await selectRootEngine(scaffold, 'claude')
    if (refused === undefined) {
      const opened = await openRootSession(scaffold, `root-engine-claude-${String(bench++)}`)
      expect(opened.error, 'a selected claude engine must open a Session').toBeUndefined()
      expect(opened.engineId).toBe('claude')
      expect(opened.executor).toBe('native')
      // Claude runs through the plugin-owned local facade, so its default route is
      // `freecodego` rather than an Anthropic-native provider id.
      expect(opened.provider).toBe('freecodego')
      return
    }
    expect(refused).toMatch(/CLAUDE_RUNTIME_NOT_INSTALLED/)
    const directory = pluginHost(scaffold).freeCodeGoHarness.catalog()
    expect(directory.defaultEngine, 'a refused pick must not change the persisted engine').toBe('freecodego')
    const row = directory.engines.find(engine => engine.id === 'claude')
    expect(row?.availability).toBe('unavailable')
    expect(row?.reasons.length, 'the claude row must still say why it is unavailable').toBeGreaterThan(0)
    const opened = await openRootSession(scaffold, `root-engine-claude-refused-${String(bench++)}`)
    expect(opened.error, 'the stand-down path must survive a refused pick').toBeUndefined()
    expect(opened.executor).toBe('adapter-loop')
  })

  it('keeps the root engine path intact across the 让位 window', async () => {
    // The live enable is where this bundle's stand-in rows hand their capability
    // over to the Harness. The handover takes rows down and starts the official
    // ones in the same reconcile, so a root Session opened around it is the one
    // window where a stale engine registry or a captured factory slot would show
    // up as a Session that cannot open.
    const enable = await pluginHost(scaffold).pluginManager.setBundleEnabled(OFFICIAL_TEAM_BUNDLE, true)
    expect(String(enable.error ?? ''), 'enabling the official Team bundle must not report a failure').toBe('')
    try {
      expect(await selectRootEngine(scaffold, 'deepseek')).toBeUndefined()
      const during = await openRootSession(scaffold, `root-engine-handover-on-${String(bench++)}`)
      expect(during.error, 'the stand-down path must survive the handover').toBeUndefined()
      expect(during.executor).toBe('adapter-loop')
      // And the directory still answers: the handover must not take the engine
      // registry down with the stand-in rows.
      expect(pluginHost(scaffold).freeCodeGoHarness.catalog().engines.map(engine => engine.id))
        .toEqual(['freecodego', 'codex', 'claude'])
    } finally {
      const disable = await pluginHost(scaffold).pluginManager.setBundleEnabled(OFFICIAL_TEAM_BUNDLE, false)
      expect(String(disable.error ?? ''), 'disabling the official Team bundle must not report a failure').toBe('')
    }
    // Back off the official bundle, the capability belongs to this bundle again and
    // the root engine path is still the same one.
    expect(await selectRootEngine(scaffold, 'deepseek')).toBeUndefined()
    const after = await openRootSession(scaffold, `root-engine-handover-off-${String(bench++)}`)
    expect(after.error, 'the stand-down path must survive the handover being undone').toBeUndefined()
    expect(after.executor).toBe('adapter-loop')
  }, 180_000)
})
