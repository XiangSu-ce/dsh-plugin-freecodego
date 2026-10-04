/**
 * The design pack's runtime: one Skills mount driven by the design switches.
 *
 * The pack owns its own fiber rather than joining the engineering one. The two
 * are independent products with independent masters — a user who wants design
 * work should not have to switch on the engineering disciplines, and turning
 * engineering off must not silently take the design Skills with it. Sharing a
 * fiber would make each switch's meaning depend on the other's state.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import { apply as applySkillFilesystem } from '@deepseek-ai/dsh-skill-filesystem'

import { forgetMountedSkillRoots, publishMountedSkillRoots } from '../mounted-skill-roots.ts'
import type { FreeCodeGoDesignSettings } from '../types.ts'
import { DESIGN_FEATURES } from './features.ts'
import { disposeToolRegistration, registerDesignTools, type ToolRegistration } from './tools.ts'
import type { FreeCodeGoDesignStatus } from './types.ts'

/** The prefix that puts a design tool into the deferred set. */
const DESIGN_TOOL_PREFIX = 'freecodego_'

/** This pack's name in the mounted-roots registry the capability map reads. */
const DESIGN_OWNER = 'design'

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
 * Whether a candidate file is a Skill the provider would serve.
 *
 * The provider skips a file whose frontmatter is absent or lacks `name` and
 * `description`, so a count that only checked the file name would count
 * `assets/design/taste/PROVENANCE.md` as a Skill: it is a loose `.md` in a
 * mounted root and it is not one. The check here mirrors that requirement rather
 * than the full parse, which is enough to tell a Skill from a sibling document.
 * @param file - absolute path of a candidate `SKILL.md` or loose `.md`.
 * @returns whether the file carries the frontmatter a Skill needs.
 */
function isSkillFile(file: string): boolean {
  try {
    const normalized = readFileSync(file, 'utf8').replaceAll('\r\n', '\n')
    if (!normalized.startsWith('---\n')) return false
    const end = normalized.indexOf('\n---', 3)
    const frontmatter = normalized.slice(4, end === -1 ? undefined : end + 1)
    return /^name:\s*\S/mu.test(frontmatter) && /^description:\s*\S/mu.test(frontmatter)
  } catch {
    return false
  }
}

/**
 * Count the Skills one asset root serves.
 *
 * Both shapes the Skills provider mounts are counted, because both are what makes
 * a row's claim true: `<root>/<name>/SKILL.md` for a directory-shaped Skill, and a
 * loose `<root>/<name>.md` for the other one it accepts. Counting only directories
 * reported `assets/design/react-bits` — whose root holds `SKILL.md` directly — as
 * serving nothing while its row read ready, which is the same blind spot the
 * capability map had.
 * @param root - an asset root the provider was mounted with.
 * @returns how many Skills the root contributes.
 */
function countSkillFiles(root: string): number {
  try {
    return readdirSync(root, { withFileTypes: true }).filter((entry) => {
      if (entry.isDirectory()) {
        const candidate = resolve(root, entry.name, 'SKILL.md')
        return existsSync(candidate) && isSkillFile(candidate)
      }
      return entry.isFile() && entry.name.endsWith('.md') && isSkillFile(resolve(root, entry.name))
    }).length
  } catch {
    return 0
  }
}

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
  /** Registration failure, kept apart from `skillsError`: the two halves fail independently. */
  private toolsError: string | undefined
  private mountedRoots: readonly string[] = []
  private mountedSkillCount = 0
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
    for (const registration of this.toolRegistrations) disposeToolRegistration(registration)
    // Reset the bookkeeping before the attempt, not after it: a registration that
    // throws would otherwise leave `registeredTools` naming the set just disposed
    // and `registeredNames` claiming a reconcile that never happened, so the page
    // would report tools this switch no longer owns and the next reconcile with
    // the same names would short-circuit instead of retrying.
    this.toolRegistrations = []
    this.registeredTools = []
    this.registeredNames = []
    if (names.length === 0) return
    const result = registerDesignTools({ ctx: this.ctx, toolPrefix: DESIGN_TOOL_PREFIX }, names)
    this.registeredNames = names
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
    // Tools and the mount have different dependencies, so a failure in one must not
    // stop the other from being attempted: a build with no tools service can still
    // mount its Skills, and a broken asset root must not also take the tools down.
    // The failure is recorded rather than thrown so the mount below still runs.
    try {
      this.reconcileTools(features.flatMap(id => DESIGN_FEATURES.find(feature => feature.id === id)?.tools ?? []))
      this.toolsError = undefined
    } catch (error) {
      if (this.closed) return
      this.toolsError = error instanceof Error ? error.message : String(error)
    }
    const roots = this.desiredRoots()
    const unchanged = roots.length === this.mountedRoots.length
      && roots.every((root, index) => root === this.mountedRoots[index])
    // A stored error must not count as "settled". It used to be part of this test,
    // so re-asserting the same switches after a failed mount short-circuited here
    // and replayed the error instead of trying again — the failure was permanent
    // for the life of the process, and a transient one looked like a broken build.
    // Retrying only when the provider is not already mounted keeps the cost to a
    // reconcile the caller explicitly asked for, and still skips a working mount.
    if (unchanged && (roots.length === 0 || this.skillsMounted)) return

    if (this.skillFiber !== undefined) {
      await this.skillFiber.dispose()
      this.skillFiber = undefined
    }
    this.skillsMounted = false
    this.skillsError = undefined
    this.mountedRoots = roots
    if (roots.length === 0) {
      this.mountedSkillCount = 0
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
    // Counted from the roots the provider was actually mounted with, so the page
    // reports the size of the mount rather than of the switch.
    this.mountedSkillCount = this.skillsMounted ? roots.reduce((total, root) => total + countSkillFiles(root), 0) : 0
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
      // The two failures are named apart rather than as one: the tools are the
      // tools service's and the mount is the asset roots', so a build with one
      // working and one broken has to say which. A row can carry both, and then it
      // says both.
      const mountFailure = root !== undefined && assetsPresent && enabled && this.skillsError !== undefined
        ? `Skill 挂载失败：${this.skillsError}`
        : undefined
      const toolsFailure = enabled && feature.tools.length > 0 && this.toolsError !== undefined
        ? `工具注册失败：${this.toolsError}`
        : undefined
      const detail = mountFailure !== undefined && toolsFailure !== undefined
        ? `${toolsFailure}；${mountFailure}`
        : toolsFailure ?? mountFailure ?? (root === undefined
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
                ? this.skillsMounted
                  ? 'Skill 已就绪，按需加载。'
                  : '等待挂载。'
                : '未启用。')
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
      ...this.toolsError === undefined ? {} : { toolsError: this.toolsError },
      registeredTools: [...this.registeredTools],
      mountedSkills: this.mountedSkillCount,
      features,
    }
  }

  /** Stand the pack down. Safe to call twice. */
  dispose(): void {
    if (this.closed) return
    this.closed = true
    forgetMountedSkillRoots(DESIGN_OWNER)
    for (const registration of this.toolRegistrations) disposeToolRegistration(registration)
    this.toolRegistrations = []
    this.registeredNames = []
    this.registeredTools = []
    const fiber = this.skillFiber
    this.skillFiber = undefined
    this.skillsMounted = false
    // Both stored failures are cleared with the state they describe: a torn-down
    // pack has no mount and no registrations, so reporting either as still broken
    // would outlive the thing it was about.
    this.skillsError = undefined
    this.toolsError = undefined
    this.mountedRoots = []
    this.mountedSkillCount = 0
    void fiber?.dispose().catch(() => undefined)
  }
}
