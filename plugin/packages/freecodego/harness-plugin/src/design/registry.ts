/**
 * The design pack's runtime: one Skills mount driven by the design switches.
 *
 * The pack owns its own fiber rather than joining the engineering one. The two
 * are independent products with independent masters — a user who wants design
 * work should not have to switch on the engineering disciplines, and turning
 * engineering off must not silently take the design Skills with it. Sharing a
 * fiber would make each switch's meaning depend on the other's state.
 */

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import { apply as applySkillFilesystem } from '@deepseek-ai/dsh-skill-filesystem'

import { forgetMountedSkillRoots, publishMountedSkillRoots } from '../mounted-skill-roots.ts'
import type { FreeCodeGoDesignSettings } from '../types.ts'
import { DESIGN_FEATURES } from './features.ts'
import { registerDesignTools } from './tools.ts'
import type { FreeCodeGoDesignStatus } from './types.ts'

/**
 * The handle a registration returns.
 *
 * `dispose` may return a promise, and this module does not await it: standing the
 * pack down is not a request the caller can be made to wait on, and the alternative
 * — an `await` in a synchronous `dispose()` — is not available. The union is here so
 * a registration whose teardown *is* asynchronous can hand its promise to a caller
 * that does have somewhere to put the wait.
 */
type ToolRegistration = (() => void) | { dispose?: () => void | Promise<void> }

/** The prefix that puts a design tool into the deferred set. */
const DESIGN_TOOL_PREFIX = 'freecodego_'

/** This pack's name in the mounted-roots registry the capability map reads. */
const DESIGN_OWNER = 'design'

/**
 * Run one registration's teardown without letting its promise escape.
 *
 * `dispose` may be synchronous or promise-returning, so the return value is a
 * union and the promise has to be narrowed out before it can be claimed. Claiming
 * it is the point: a teardown that returns a promise and is called for its side
 * effect leaves an unhandled rejection behind when it fails — which would make
 * *standing the pack down* the path that takes the host process with it. Nothing
 * is reported because there is nowhere to report it: the caller has already said
 * the pack is not wanted.
 */
function disposeRegistration(registration: ToolRegistration): void {
  if (typeof registration === 'function') {
    registration()
    return
  }
  void Promise.resolve(registration.dispose?.()).catch(() => undefined)
}

/** The slice of a plugin fiber this module needs; a mount that fails throws. */
type Fiber = { dispose(): Promise<void> }

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url))

/**
 * Resolve a bundled asset root.
 *
 * The list of candidate depths is deliberate rather than clever: the same module
 * runs from `src/` under ts-node and from `dist/` after a build, so the root sits
 * at a different distance in each. Trying each and taking the first that exists
 * keeps one source file correct in both layouts.
 */
function assetDirectory(relative: string): string {
  const candidates = [
    resolve(MODULE_DIRECTORY, relative),
    resolve(MODULE_DIRECTORY, '..', relative),
    resolve(MODULE_DIRECTORY, '..', '..', relative),
    resolve(MODULE_DIRECTORY, '..', '..', '..', relative),
    resolve(MODULE_DIRECTORY, '..', '..', '..', '..', relative),
  ]
  return candidates.find(existsSync) ?? resolve(MODULE_DIRECTORY, '..', relative)
}

/** Where each feature's Skills live, resolved once at module load. */
const FEATURE_SKILL_ROOTS: ReadonlyMap<string, string> = new Map(
  DESIGN_FEATURES
    .filter(feature => feature.skillRoot !== undefined)
    .map(feature => [feature.id, assetDirectory(feature.skillRoot as string)]),
)

/**
 * The settings surface this module needs, typed loosely on purpose.
 *
 * The Host's settings service holds one document for every feature this plugin
 * has, so restating its shape here would mean this file breaking each time an
 * unrelated setting is added — and a second declaration of the design slice that
 * could disagree with `types.ts`. The registry narrows what it reads through
 * {@link normalizeDesignSettings}, which is where the defaults live anyway.
 */
export interface DesignSettingsScope {
  get(): unknown
  update(value: unknown): Promise<void>
}

/** Normalize a persisted switch list: known ids only, no duplicates, in page order. */
export function normalizeDesignFeatures(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const chosen = new Set(value.filter((entry): entry is string => typeof entry === 'string'))
  return DESIGN_FEATURES.filter(feature => chosen.has(feature.id)).map(feature => feature.id)
}

/** Normalize the design slice of the settings object. */
export function normalizeDesignSettings(value: unknown): FreeCodeGoDesignSettings {
  // `undefined` and a non-object both read as "nothing was ever stored", which
  // is what a fresh install has. Turning that into the off state here means no
  // caller has to carry a nullable settings document.
  const source = (typeof value === 'object' && value !== null ? value : {}) as Partial<FreeCodeGoDesignSettings>
  return {
    designEnabled: source.designEnabled === true,
    designFeaturesEnabled: normalizeDesignFeatures(source.designFeaturesEnabled),
  }
}

export class FreeCodeGoDesignRegistry {
  private skillFiber: Fiber | undefined
  private skillsMounted = false
  private skillsError: string | undefined
  private mountedRoots: readonly string[] = []
  private toolRegistrations: ToolRegistration[] = []
  private registeredTools: readonly string[] = []
  private registeredNames: readonly string[] = []
  private queue: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    private readonly ctx: Context,
    private readonly settings: DesignSettingsScope | undefined,
  ) {}

  /** Begin owning the pack. Teardown runs through the Harness effect seam. */
  start(): void {
    this.ctx.effect(() => () => { this.dispose() }, 'freecodego: design pack')
    void this.enqueue(async () => this.reconcile()).catch(() => undefined)
  }

  private configuration(): FreeCodeGoDesignSettings {
    return normalizeDesignSettings(this.settings?.get())
  }

  /**
   * Serialize every mount/unmount behind one chain.
   *
   * Two reconciles must not interleave: each one disposes the fiber it saw and
   * mounts the roots it computed, so an interleaving leaves a disposed fiber as
   * `skillFiber` while its replacements are still being created, and the next
   * teardown then disposes something that is already gone.
   */
  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task, task)
    return this.queue
  }

  /** The features the current switches authorize, in page order. */
  private enabledFeatures(): readonly string[] {
    const settings = this.configuration()
    return settings.designEnabled ? [...settings.designFeaturesEnabled] : []
  }

  /** The asset roots the current switches authorize, in page order. */
  private desiredRoots(): readonly string[] {
    return this.enabledFeatures()
      .map(id => FEATURE_SKILL_ROOTS.get(id))
      .filter((root): root is string => root !== undefined && existsSync(root))
  }

  /**
   * Register and unregister the enabled features' tools.
   *
   * Kept separate from the Skills fiber because the two have different
   * dependencies: a tool needs the tools service, a Skill needs an asset root,
   * and a build missing one of those should still get the other. Tying them
   * together would make a missing asset directory silently take a working tool
   * with it.
   */
  private reconcileTools(names: readonly string[]): void {
    const unchanged = names.length === this.registeredNames.length
      && names.every((name, index) => name === this.registeredNames[index])
    if (unchanged) return
    for (const registration of this.toolRegistrations) disposeRegistration(registration)
    this.toolRegistrations = []
    this.registeredNames = names
    if (names.length === 0) {
      this.registeredTools = []
      return
    }
    const result = registerDesignTools({ ctx: this.ctx, toolPrefix: DESIGN_TOOL_PREFIX }, names)
    this.toolRegistrations = [...result.registrations]
    this.registeredTools = result.registered
  }

  /** Mount, unmount, or leave the Skills fiber alone as the switches require. */
  private async reconcile(): Promise<void> {
    if (this.closed) return
    // Tools first: a composition can be linted and catalogued with no asset root
    // present, so a build without the Skill pack still gets the two tools that
    // need no browser.
    const features = this.enabledFeatures()
    this.reconcileTools(features.flatMap(id => DESIGN_FEATURES.find(feature => feature.id === id)?.tools ?? []))
    const roots = this.desiredRoots()
    const unchanged = roots.length === this.mountedRoots.length
      && roots.every((root, index) => root === this.mountedRoots[index])
    if (unchanged && (roots.length === 0 || this.skillsMounted || this.skillsError !== undefined)) return

    if (this.skillFiber !== undefined) {
      await this.skillFiber.dispose()
      this.skillFiber = undefined
    }
    this.skillsMounted = false
    this.skillsError = undefined
    this.mountedRoots = roots
    if (roots.length === 0) {
      publishMountedSkillRoots(DESIGN_OWNER, [])
      return
    }

    try {
      const fiber = await this.ctx.plugin({
        name: 'freecodego-design-skills',
        inject: ['skills'],
        apply: applySkillFilesystem,
      }, {
        providerName: 'freecodego-design',
        includeDefaultRoots: false,
        customSkillDirs: [...roots],
      })
      // A teardown that ran while the mount was in flight has already taken the
      // pack down, and it saw no fiber to dispose: `dispose()` cleared
      // `skillFiber` while this call was awaiting the mount. Assigning here would
      // leave a mounted provider with no owner — and the `publish` below would
      // announce Skills belonging to a pack the user has switched off, after that
      // same teardown had already withdrawn them.
      if (this.isClosed()) {
        void fiber.dispose().catch(() => undefined)
        return
      }
      this.skillFiber = fiber
      this.skillsMounted = true
    } catch (error) {
      // A mount that failed after the pack was torn down has nowhere to report:
      // the row it belongs to is gone, and setting the error here would revive a
      // state `dispose()` just cleared.
      if (this.isClosed()) return
      // A directory on disk is not a mounted provider. Report the mount failure
      // itself, because "assets missing" and "the fiber threw" need different
      // fixes and the page would otherwise show them as the same state.
      this.skillFiber = undefined
      this.skillsMounted = false
      this.skillsError = error instanceof Error ? error.message : String(error)
    }
    // Published after the attempt and carrying its outcome, so the capability map
    // cannot announce Skills whose provider failed to mount.
    publishMountedSkillRoots(DESIGN_OWNER, this.skillsMounted ? roots : [])
  }

  /** Switch the whole pack on or off. @param enabled - the desired state. */
  async setEnabled(enabled: boolean): Promise<FreeCodeGoDesignStatus> {
    return this.update({ designEnabled: enabled })
  }

  /**
   * Switch one feature on or off.
   *
   * Turning a feature on also turns the pack on, because the two statements are
   * the same one: a user who switches on HyperFrames has said what they want, and
   * asking them to also find a master switch first would be making them say it
   * twice. Turning a feature off leaves the pack alone — the remaining features
   * are still theirs to keep.
   *
   * @param id - the feature id.
   * @param enabled - the desired state.
   */
  async setFeatureEnabled(id: string, enabled: boolean): Promise<FreeCodeGoDesignStatus> {
    const current = this.configuration()
    const chosen = new Set(current.designFeaturesEnabled)
    if (enabled) chosen.add(id)
    else chosen.delete(id)
    const designFeaturesEnabled = [...chosen]
    return this.update(enabled ? { designEnabled: true, designFeaturesEnabled } : { designFeaturesEnabled })
  }

  /**
   * Persist a settings patch and bring the mount in line with it.
   *
   * Enabling a feature is what turns the pack on: a user who switches on
   * HyperFrames has stated their intent for the pack, so requiring a separate
   * master switch first would be asking them to say it twice. The master switch
   * still stands the whole thing down without forgetting their choices.
   */
  async update(input: Partial<FreeCodeGoDesignSettings>): Promise<FreeCodeGoDesignStatus> {
    if (this.settings === undefined) throw new Error('FreeCodeGo settings are not configured')
    // Read the whole document, not the design slice. The settings service stores
    // one object for every feature this plugin has, and `update` replaces it — so
    // writing the normalized slice back would drop every other feature's settings
    // on the first toggle. Spreading the raw document forward is what makes this
    // module's ignorance of the rest of the shape safe rather than destructive.
    const raw = this.settings.get()
    const base = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<FreeCodeGoDesignSettings> & Record<string, unknown>
    const normalized = normalizeDesignSettings({ ...base, ...input })
    const next: Record<string, unknown> = { ...base }
    next.designEnabled = normalized.designEnabled
    next.designFeaturesEnabled = normalized.designFeaturesEnabled
    await this.settings.update(next)
    await this.enqueue(async () => this.reconcile())
    return this.status()
  }

  /**
   * Whether the pack has been taken down.
   *
   * Read through a call rather than as a field, and that is load-bearing. A
   * property read narrowed to `false` at the top of {@link reconcile} stays
   * narrowed for the rest of that method, including across the `await` that
   * mounts the Skills provider — which is precisely the moment {@link dispose}
   * can run and set it. The check that guards the mount would then be read as
   * provably unreachable, and the next reader would delete the guard that exists
   * to dispose a fiber nobody owns. A call is not narrowed, so this reads the
   * field as it is now.
   *
   * @returns whether this registry has been disposed.
   */
  private isClosed(): boolean {
    return this.closed
  }

  /** @returns what the design page renders. */
  async status(): Promise<FreeCodeGoDesignStatus> {
    const settings = this.configuration()
    const chosen = new Set(settings.designFeaturesEnabled)
    const features = DESIGN_FEATURES.map((feature) => {
      // An asset root that is missing is reported as a reason rather than by
      // hiding the row: the switch is real, the user asked for this capability,
      // and "the thing you switched on is not in this build" is the answer.
      const root = FEATURE_SKILL_ROOTS.get(feature.id)
      const assetsPresent = root === undefined || existsSync(root)
      const enabled = settings.designEnabled && chosen.has(feature.id)
      // A feature that ships no Skills has no mount to wait for and no asset
      // root to be missing, so its row explains the switch itself instead of
      // reporting a mount state it will never have. The master switch still wins:
      // with the pack off, every row says the same thing, which is what the user
      // just did.
      const detail = root === undefined
        ? enabled
          ? '已启用：工具按需加载，不挂载 Skill 资源。'
          : settings.designEnabled
            ? '未启用。'
            : '设计功能总开关已关闭。'
        : !assetsPresent
          ? '内置 Skill 资源在此构建中缺失，无法启用。'
          : !settings.designEnabled
            ? '设计功能总开关已关闭。'
            : enabled
              ? this.skillsError !== undefined
                ? `Skill 挂载失败：${this.skillsError}`
                : this.skillsMounted
                  ? 'Skill 已就绪，按需加载。'
                  : '等待挂载。'
              : '未启用。'
      return {
        id: feature.id,
        label: feature.label,
        summary: feature.summary,
        // The tools this feature actually registered, not the ones it declares.
        // `features.ts` lists what the capability is meant to provide; a build
        // that has not implemented one of them must not answer as if it had.
        tools: enabled ? feature.tools.filter(tool => this.registeredTools.includes(tool)) : [],
        enabled,
        available: assetsPresent,
        detail,
      }
    })
    return {
      designEnabled: settings.designEnabled,
      skillsReady: this.skillsMounted && this.skillsError === undefined,
      ...this.skillsError === undefined ? {} : { skillsError: this.skillsError },
      features,
    }
  }

  /** Stand the pack down. Safe to call twice. */
  dispose(): void {
    if (this.closed) return
    this.closed = true
    forgetMountedSkillRoots(DESIGN_OWNER)
    for (const registration of this.toolRegistrations) disposeRegistration(registration)
    this.toolRegistrations = []
    this.registeredNames = []
    this.registeredTools = []
    const fiber = this.skillFiber
    this.skillFiber = undefined
    this.skillsMounted = false
    this.mountedRoots = []
    void fiber?.dispose().catch(() => undefined)
  }
}
