/**
 * The design pack's switches and its Skills mount.
 *
 * Two things are load-bearing here and neither is visible from the page:
 *
 * 1. **The mount is a directory decision.** What the user ticks has to end up as
 *    the root list handed to the Skills fiber, because that list is the only
 *    thing keeping the page and the mount from disagreeing.
 * 2. **A failed mount is not a mounted one.** The assets are in the tree either
 *    way, so `existsSync` alone reports a pack that is switched on and broken as
 *    ready — the failure has to reach the page as a reason.
 *
 * @module
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { FreeCodeGoDesignRegistry, normalizeDesignFeatures, normalizeDesignSettings } from '../src/design/registry.ts'
import type { FreeCodeGoDesignStatus } from '../src/design/types.ts'
import { DESIGN_FEATURES, HYPERFRAMES_FEATURE, REACTBITS_FEATURE, TASTE_FEATURE } from '../src/design/features.ts'
import { forgetMountedSkillRoots, mountedPluginSkillRoots } from '../src/mounted-skill-roots.ts'

/** One mount the fake fiber recorded. */
interface Mount {
  readonly definition: { readonly name?: string; readonly inject?: readonly string[] }
  readonly config: { readonly providerName?: string; readonly customSkillDirs?: readonly string[]; readonly includeDefaultRoots?: boolean }
}

/** A context that records fibers instead of creating them.
 *
 * `mountGate` is what makes a mount *in flight* observable: the fiber resolves
 * only once the returned promise does, so a case can tear the pack down while a
 * mount is still pending — the window no single-threaded reading of the code
 * would otherwise reach.
 */
function fakeContext(options: { readonly failMount?: boolean; readonly mountGate?: Promise<void> } = {}): {
  readonly ctx: {
    effect(factory: () => () => void, name?: string): unknown
    plugin(definition: unknown, config: unknown): Promise<{ dispose(): Promise<void> }>
    get(name: string): unknown
  }
  readonly mounts: Mount[]
  /** How many mount calls this context was asked to make, gate included. */
  readonly attempts: () => number
  /** Every fiber this context created, whether or not it is still mounted. */
  readonly created: number
  /** How many of those were disposed again. */
  readonly disposed: () => number
  /** The tool names the fake tools service was handed, in registration order. */
  readonly toolNames: string[]
  readonly runTeardown: () => void
} {
  const mounts: Mount[] = []
  const toolNames: string[] = []
  const teardowns: (() => void)[] = []
  let attempts = 0
  let created = 0
  let disposed = 0
  return {
    get created() { return created },
    attempts: () => attempts,
    disposed: () => disposed,
    ctx: {
      effect: (factory) => { teardowns.push(factory()); return () => undefined },
      plugin: async (definition, config) => {
        attempts += 1
        // Awaited only when a case supplies one: an unconditional `await` would
        // defer every mount by a microtask, which is a different world from the
        // one the synchronous cases assert against.
        if (options.mountGate !== undefined) await options.mountGate
        if (options.failMount === true) throw new Error('mount exploded')
        created += 1
        mounts.push({ definition: definition as Mount['definition'], config: config as Mount['config'] })
        return { dispose: async () => { disposed += 1; mounts.pop() } }
      },
      // The disposer removes the name, so a tool that stayed registered after the
      // switch went off is visible here rather than only in the status.
      get: (name: string) => name === 'tools'
        ? { register: (tool: { readonly name?: string }) => { toolNames.push(tool.name ?? ''); return () => { const at = toolNames.indexOf(tool.name ?? ''); if (at >= 0) toolNames.splice(at, 1) } } }
        : undefined,
    },
    mounts,
    toolNames,
    runTeardown: () => { for (const teardown of teardowns) teardown() },
  }
}

/** A settings scope over one in-memory document. */
function fakeSettings(initial?: unknown): { readonly scope: { get(): unknown; update(value: unknown): Promise<void> }; readonly read: () => Record<string, unknown> } {
  let value: unknown = initial
  return {
    scope: {
      get: () => value,
      update: async (next) => { value = next },
    },
    read: () => (typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}),
  }
}

describe('design settings normalization', () => {
  it('reads a fresh install as off, not as missing', () => {
    // The page renders a switch before anything has ever been saved. A nullable
    // settings document would make every caller carry the same null check, and
    // one of them would forget and show an enabled pack on a clean install.
    expect(normalizeDesignSettings(undefined)).toEqual({ designEnabled: false, designFeaturesEnabled: [] })
    expect(normalizeDesignSettings(null)).toEqual({ designEnabled: false, designFeaturesEnabled: [] })
    expect(normalizeDesignSettings('not an object')).toEqual({ designEnabled: false, designFeaturesEnabled: [] })
  })

  it('keeps only ids that are still shipped, in page order', () => {
    // A stored id whose feature was removed must not survive as a switch that
    // does nothing, and the order has to come from the catalogue rather than
    // from the list: the page renders the list it is given.
    expect(normalizeDesignFeatures(['nope'])).toEqual([])
    expect(normalizeDesignFeatures(['hyperframes', 'hyperframes'])).toEqual(['hyperframes'])
    expect(normalizeDesignFeatures('hyperframes')).toEqual([])
    expect(normalizeDesignFeatures([7, 'hyperframes'])).toEqual(['hyperframes'])
  })

  it('resolves the catalogue order rather than the stored order', () => {
    const reversed = [...DESIGN_FEATURES].reverse().map(feature => feature.id)
    expect(normalizeDesignFeatures(reversed)).toEqual(DESIGN_FEATURES.map(feature => feature.id))
  })
})

describe('the design pack', () => {
  let world: ReturnType<typeof fakeContext>
  let settings: ReturnType<typeof fakeSettings>
  let registry: FreeCodeGoDesignRegistry

  beforeEach(() => {
    // The registry is process-scoped, so a case has to withdraw what it published;
    // otherwise the first case to mount makes every later one pass for free.
    forgetMountedSkillRoots('design')
    world = fakeContext()
    settings = fakeSettings()
    registry = new FreeCodeGoDesignRegistry(world.ctx as never, settings.scope)
  })

  it('publishes its root so the capability map can name the design Skills', async () => {
    registry.start()
    await registry.setFeatureEnabled(HYPERFRAMES_FEATURE.id, true)
    // The map reads this registry, not the design registry's private list — that
    // indirection is what made 17 mounted Skills invisible before.
    expect(mountedPluginSkillRoots()).toHaveLength(1)
    expect(mountedPluginSkillRoots()[0]).toMatch(/assets[\\/]design[\\/]skills$/u)
  })

  it('publishes nothing when the mount fails, so the map cannot announce dead Skills', async () => {
    world = fakeContext({ failMount: true })
    registry = new FreeCodeGoDesignRegistry(world.ctx as never, settings.scope)
    registry.start()
    await registry.setFeatureEnabled(HYPERFRAMES_FEATURE.id, true)
    // The directory is on disk in both cases; only the mount's outcome separates
    // "listed and callable" from "listed and unreachable".
    expect(mountedPluginSkillRoots()).toEqual([])
    registry.dispose()
    expect(mountedPluginSkillRoots()).toEqual([])
  })

  it('disposes a mount that finished after the pack was taken down', async () => {
    // The window a single-threaded reading never reaches: `dispose()` runs while
    // the mount is still awaiting the fiber. A teardown sees no fiber to dispose
    // because the mount has not assigned one yet — so the assignment that follows
    // it must not happen, or the provider stays mounted with no owner, and the
    // publish at the end of the mount re-announces Skills this teardown already
    // withdrew.
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    world = fakeContext({ mountGate: gate })
    registry = new FreeCodeGoDesignRegistry(world.ctx as never, settings.scope)
    registry.start()

    const enabling = registry.setFeatureEnabled(HYPERFRAMES_FEATURE.id, true)
    // Let the settings write and the queued reconcile settle, so the mount is
    // genuinely in flight: asked for, and not finished.
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(world.attempts()).toBe(1)
    expect(world.created).toBe(0)
    registry.dispose()
    release()
    const status = await enabling as FreeCodeGoDesignStatus

    expect(world.created).toBe(1)
    expect(world.disposed()).toBe(1)
    expect(mountedPluginSkillRoots()).toEqual([])
    // And the status that came back is the torn-down one rather than a pack that
    // reports itself ready on the strength of a fiber nobody owns.
    expect(status.designEnabled).toBe(true)
    expect(status.skillsReady).toBe(false)
  })

  it('mounts nothing until a feature is switched on', async () => {
    registry.start()
    await registry.status()
    expect(world.mounts).toHaveLength(0)
    const status = await registry.status()
    expect(status.designEnabled).toBe(false)
    expect(status.skillsReady).toBe(false)
  })

  it('turns the pack on when a feature is turned on, and mounts that feature root', async () => {
    registry.start()
    const status = await registry.setFeatureEnabled(HYPERFRAMES_FEATURE.id, true)
    expect(status.designEnabled).toBe(true)
    expect(status.skillsReady).toBe(true)
    expect(world.mounts).toHaveLength(1)
    // One fiber, the design provider, and only the chosen root: `includeDefaultRoots`
    // false is what keeps the user's own Skill directories out of this mount.
    expect(world.mounts[0]!.config.providerName).toBe('freecodego-design')
    expect(world.mounts[0]!.config.includeDefaultRoots).toBe(false)
    expect(world.mounts[0]!.config.customSkillDirs).toHaveLength(1)
    expect(world.mounts[0]!.config.customSkillDirs?.[0]).toMatch(/assets[\\/]design[\\/]skills$/u)
    expect(world.mounts[0]!.definition.inject).toEqual(['skills'])
  })

  it('reports a failed mount as a reason instead of as ready', async () => {
    world = fakeContext({ failMount: true })
    registry = new FreeCodeGoDesignRegistry(world.ctx as never, settings.scope)
    registry.start()
    const status = await registry.setFeatureEnabled(HYPERFRAMES_FEATURE.id, true)
    // The assets are on disk in both cases, so only the mount flag separates
    // "working" from "present but broken".
    expect(status.skillsReady).toBe(false)
    expect(status.skillsError).toBe('mount exploded')
    expect(status.features[0]!.detail).toContain('mount exploded')
  })

  it('unmounts everything when the master switch goes off but keeps the choices', async () => {
    registry.start()
    await registry.setFeatureEnabled(HYPERFRAMES_FEATURE.id, true)
    const status = await registry.setEnabled(false)
    expect(world.mounts).toHaveLength(0)
    expect(status.features[0]!.enabled).toBe(false)
    // The choice survives the master switch: standing the pack down is not the
    // same as forgetting which capabilities the user wanted.
    expect(settings.read().designFeaturesEnabled).toEqual([HYPERFRAMES_FEATURE.id])
  })

  it('keeps every feature inside the deferred tool namespace', () => {
    // The `freecodego_` prefix is what puts these into the deferred set, so an
    // unprefixed name would be a tool that costs context in every session.
    const tools = DESIGN_FEATURES.flatMap(feature => feature.tools)
    expect(tools.length).toBeGreaterThan(0)
    for (const tool of tools) expect(tool.startsWith('freecodego_')).toBe(true)
  })

  it('gives every row something to install, so a switch cannot be decorative', () => {
    // A row's two payloads are a tool and a Skill root. Nothing else in this file
    // would notice a row with neither: an empty mount is what a tool-only row
    // legitimately has, an empty registered list is what a Skill-only row
    // legitimately has, and `status()` derives its fields from both — so such a row
    // would render as switchable and report 已启用 while changing nothing at all.
    // The invariant is asserted once here instead, and it is what keeps a behaviour
    // document, which installs neither payload, off this page (`design/types.ts`
    // records why that category is not a row).
    for (const feature of DESIGN_FEATURES) {
      const payload = feature.tools.length > 0 || feature.skillRoot !== undefined
      expect(payload, `${feature.id} provides neither a tool nor a Skill root`).toBe(true)
    }
  })

  it('registers every tool the catalogue declares, and reports what registered', async () => {
    registry.start()
    const status = await registry.setFeatureEnabled(HYPERFRAMES_FEATURE.id, true)
    // The catalogue is the statement; the report is the registered set, and the
    // two are separate lists on purpose — a name with no implementation is
    // skipped and reported as absent (`design-tools.spec.ts` covers the
    // disagreeing case). They agree here because every declared name is
    // implemented, which is what makes this equality worth asserting: it fails the
    // moment a name is added to the catalogue ahead of its implementation.
    expect(world.toolNames).toEqual([...HYPERFRAMES_FEATURE.tools])
    expect(status.features[0]!.tools).toEqual([...HYPERFRAMES_FEATURE.tools])
  })

  it('withdraws the tools when the master switch goes off', async () => {
    registry.start()
    await registry.setFeatureEnabled(HYPERFRAMES_FEATURE.id, true)
    const status = await registry.setEnabled(false)
    // A tool left registered after the switch went off is a capability the page
    // says is off and the model can still call. The status alone cannot tell the
    // two apart — it derives `tools` from what was registered, so an empty list
    // there would also be produced by never having registered anything.
    expect(world.toolNames).toEqual([])
    expect(status.features[0]!.tools).toEqual([])
    expect(mountedPluginSkillRoots()).toEqual([])
  })

  it('switches on every capability with no Skills, registering its tools and mounting nothing', async () => {
    // Driven by the catalogue rather than by one row, because the assertion is about
    // a *kind* of capability: one whose whole installation is its tools. There is no
    // asset root to mount, so a switch that waited for one would show the row as
    // pending forever — and a new row of this kind is covered the day it is added.
    const withoutSkills = DESIGN_FEATURES.filter(feature => feature.skillRoot === undefined)
    expect(withoutSkills.length).toBeGreaterThan(1)
    registry.start()
    let status = await registry.status()
    for (const feature of withoutSkills) status = await registry.setFeatureEnabled(feature.id, true)

    expect(world.mounts).toHaveLength(0)
    expect(mountedPluginSkillRoots()).toEqual([])
    expect(world.toolNames).toEqual(withoutSkills.flatMap(feature => [...feature.tools]))
    for (const feature of withoutSkills) {
      const row = status.features.find(candidate => candidate.id === feature.id)
      expect(row, feature.id).toBeDefined()
      expect(row?.enabled, feature.id).toBe(true)
      // Available without an asset root: `available` gates the switch, and a
      // capability whose data ships inside the package must not be reported as
      // missing it.
      expect(row?.available, feature.id).toBe(true)
      expect(row?.tools, feature.id).toEqual([...feature.tools])
      expect(row?.detail, feature.id).toContain('不挂载 Skill 资源')
    }
  })

  it('mounts the React Bits row\u2019s own Skill root, which is written here rather than vendored', async () => {
    // The fourth row is a mixed one: a Skill root this repository *wrote*, beside a
    // tool that reads upstream over the network. The mount matters because a Skill is
    // the only thing in the capability that can explain the licence boundary before a
    // component is fetched at all — and the row has to report the mount the way the
    // other Skill-bearing rows do, since it is a real provider and not a promise.
    registry.start()
    const status = await registry.setFeatureEnabled(REACTBITS_FEATURE.id, true)
    const row = status.features.find(feature => feature.id === REACTBITS_FEATURE.id)
    expect(row?.available).toBe(true)
    expect(row?.detail).toBe('Skill 已就绪，按需加载。')
    expect(row?.tools).toEqual([...REACTBITS_FEATURE.tools])
    expect(world.mounts).toHaveLength(1)
    const roots = world.mounts[0]?.config.customSkillDirs ?? []
    expect(roots.some(root => /assets[\\/]design[\\/]react-bits$/u.test(root))).toBe(true)
  })

  it('mounts a row whose whole installation is prose, with nothing to register', async () => {
    // The fifth row is the first with an empty `tools` list, and the empty list is
    // the row rather than an omission: everything it provides is the prose a selected
    // Skill puts into context. The page has to report that honestly — a mount that
    // succeeded, and a tool list that is empty because there is nothing to register,
    // which is not the same state as tools that failed to register.
    registry.start()
    const status = await registry.setFeatureEnabled(TASTE_FEATURE.id, true)
    const row = status.features.find(feature => feature.id === TASTE_FEATURE.id)
    expect(row?.available).toBe(true)
    expect(row?.enabled).toBe(true)
    expect(row?.tools).toEqual([])
    expect(row?.detail).toBe('Skill 已就绪，按需加载。')
    expect(world.toolNames).toEqual([])
    expect(world.mounts).toHaveLength(1)
    const roots = world.mounts[0]?.config.customSkillDirs ?? []
    expect(roots.some(root => /assets[\\/]design[\\/]taste$/u.test(root))).toBe(true)
  })

  it('reports the master switch for every no-Skill row too, rather than a mount state', async () => {
    registry.start()
    for (const feature of DESIGN_FEATURES) await registry.setFeatureEnabled(feature.id, true)
    const status = await registry.setEnabled(false)
    // One sentence for the whole page once the pack is off: a row that kept talking
    // about a mount would describe a mechanism it does not have, and a row that kept
    // listing tools would be describing a surface the model can no longer call.
    for (const feature of DESIGN_FEATURES) {
      const row = status.features.find(candidate => candidate.id === feature.id)
      expect(row?.enabled, feature.id).toBe(false)
      expect(row?.detail, feature.id).toBe('设计功能总开关已关闭。')
      expect(row?.tools, feature.id).toEqual([])
    }
    expect(world.toolNames).toEqual([])
  })

  it('leaves every other setting in the document alone', async () => {
    // The settings service stores one object for the whole plugin and `update`
    // replaces it. Writing the normalized design slice back therefore drops every
    // unrelated key — a toggle that silently resets the model routing, the account
    // refs, and the review switches is the kind of loss a user cannot attribute to
    // the control they just touched.
    settings = fakeSettings({ engineeringEnabled: true, model: 'deepseek-v4-flash', designEnabled: false })
    registry = new FreeCodeGoDesignRegistry(world.ctx as never, settings.scope)
    registry.start()
    await registry.setFeatureEnabled(HYPERFRAMES_FEATURE.id, true)
    expect(settings.read().engineeringEnabled).toBe(true)
    expect(settings.read().model).toBe('deepseek-v4-flash')
    expect(settings.read().designEnabled).toBe(true)
  })

  it('drops a stored feature id that is no longer shipped', async () => {
    settings = fakeSettings({ designEnabled: true, designFeaturesEnabled: ['hyperframes', 'retired'] })
    registry = new FreeCodeGoDesignRegistry(world.ctx as never, settings.scope)
    registry.start()
    const status = await registry.status()
    expect(status.features).toHaveLength(DESIGN_FEATURES.length)
    expect(status.features.map(feature => feature.id)).toEqual(DESIGN_FEATURES.map(feature => feature.id))
    expect(world.mounts[0]!.config.customSkillDirs).toHaveLength(1)
  })

  it('leaves the fiber alone when a reconcile has nothing to change', async () => {
    registry.start()
    await registry.setFeatureEnabled(HYPERFRAMES_FEATURE.id, true)
    await registry.status()
    await registry.setEnabled(true)
    // Re-mounting on every read is the shape that makes a working pack blink in
    // and out while the page polls.
    expect(world.mounts).toHaveLength(1)
  })

  it('is safe to dispose twice, and disposes through the effect seam', async () => {
    registry.start()
    await registry.setFeatureEnabled(HYPERFRAMES_FEATURE.id, true)
    world.runTeardown()
    expect(world.mounts).toHaveLength(0)
    expect(() => registry.dispose()).not.toThrow()
  })
})
