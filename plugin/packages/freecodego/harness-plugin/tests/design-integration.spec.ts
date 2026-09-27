/**
 * The design pack, wired to the real plugin and the real Skill service.
 *
 * Every other design spec replaces a service with a double, which is what makes
 * them fast and what leaves one question open: does *this* composition — the
 * actual `FreeCodeGoHarnessPlugin`, built from its own config schema, mounting
 * through the actual `@deepseek-ai/dsh-skill-filesystem`, listing through the
 * actual `@deepseek-ai/dsh-skill` — produce the state the doubles were asserting
 * on? A double agrees with whatever the code under test believes about it.
 *
 * So this spec provides only what the plugin genuinely cannot run without
 * (settings, an empty agent registry) and lets everything else be real. The
 * assertions are the ones that would be lies if the wiring were wrong: the 17
 * Skill names coming back out of the Skill service, and the tool definitions
 * coming back out of the tool service and executing.
 *
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { apply as applySkillFilesystem } from '@deepseek-ai/dsh-skill-filesystem'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import { FreeCodeGoHarnessPlugin } from '../src/index.ts'
import { forgetMountedSkillRoots, mountedPluginSkillRoots } from '../src/mounted-skill-roots.ts'
import { provideHostService, provideHostServiceAs, runContext, settingsSink, type AgentEnginesFace } from './support/host-services.ts'

/** The service the plugin's constructor reaches for before anything else. */
function AgentEngineRegistry(ctx: Context): void {
  provideHostServiceAs<AgentEnginesFace>(ctx, 'agentEngines', { setAvailability: () => undefined })
  provideHostService(ctx, 'agents', { list: () => [], get: () => undefined })
}

/** The plugin face this spec drives. */
interface DesignPluginFace {
  designStatus(): Promise<{
    readonly designEnabled: boolean
    readonly skillsReady: boolean
    readonly skillsError?: string
    readonly features: readonly {
      readonly id: string
      readonly label: string
      readonly summary: string
      readonly enabled: boolean
      readonly available: boolean
      readonly tools: readonly string[]
      readonly detail: string
    }[]
  }>
  designSetEnabled(enabled: boolean): Promise<unknown>
  designFeatureSetEnabled(id: string, enabled: boolean): Promise<unknown>
}

/** The Skill service, viewed the way this spec reads it. */
type SkillListFace = { list(): Promise<readonly { readonly name: string }[]> }

/** A composition that satisfies every rule the linter implements. */
const CLEAN_COMPOSITION = [
  '<div id="stage" data-composition-id="intro" data-width="1280" data-height="720">',
  '<div class="dot">hi</div>',
  '</div>',
  '<script>gsap.to(".dot", { y: -20, duration: 1 });</script>',
].join('\n')

/** A composition the linter must refuse. */
const DIRTY_COMPOSITION = [
  '<div id="stage">',
  '<script>const seed = Math.random();</script>',
  '</div>',
].join('\n')

/** Build one plugin over real services, with the design pack switched on. */
async function withPlugin(options: { readonly enabled?: boolean; readonly features?: readonly string[] } = {}): Promise<{
  readonly ctx: Context
  readonly definitions: ToolDefinition[]
  readonly read: (path: string) => string
  /** Put one file's own text under a path, for a tool whose subject is not a composition. */
  readonly seed: (path: string, text: string) => string
  /** Whatever is at a path, including a file a tool wrote there. */
  readonly written: (path: string) => string | undefined
  readonly dispose: () => Promise<void>
  readonly design: DesignPluginFace
}> {
  const home = await mkdtemp(join(tmpdir(), 'freecodego-design-integration-'))
  const ctx = new Context()
  await ctx.plugin(AgentEngineRegistry)
  await ctx.plugin(SkillRegistry)
  const settings = settingsSink(ctx, {
    designEnabled: options.enabled ?? true,
    designFeaturesEnabled: options.enabled === false ? [] : [...options.features ?? ['hyperframes']],
  })
  const definitions: ToolDefinition[] = []
  // A file service rather than direct reads: the tool takes a model-supplied
  // path, so it is required to go through this seam and a composition reaches it
  // as text. The map is addressed by the resolved path the tool asks for.
  const files = new Map<string, string>()
  provideHostService(ctx, 'fs', {
    resolve: async (path: string) => path as never,
    readText: async (target: unknown) => {
      const text = files.get(String(target))
      if (text === undefined) throw new Error(`ENOENT: ${String(target)}`)
      return text
    },
    // Writable, because one design row's tool has a write action: the seam it writes
    // through is this one, and a fixture that could only read would prove nothing
    // about whether the plugin hands the tool the service that can write.
    writeText: async (target: unknown, content: string) => {
      const existed = files.has(String(target))
      files.set(String(target), content)
      // The version is the backend's own opaque token, so this fixture supplies one
      // without pretending to be a real one — nothing in the cases below reads it.
      return { operation: existed ? 'update' : 'create', version: 'integration-fixture' as never, before: existed ? '' : null, after: content }
    },
  })
  provideHostService(ctx, 'tools', {
    // The disposer withdraws the definition, as the real registry does. A fake
    // that kept a withdrawn tool in the list would let "the switch withdrew it"
    // pass against a tool that is still registered there.
    register: (definition) => {
      definitions.push(definition)
      return () => {
        const at = definitions.indexOf(definition)
        if (at >= 0) definitions.splice(at, 1)
      }
    },
    guard: () => () => undefined,
    schemas: () => [],
  })
  const plugin = new FreeCodeGoHarnessPlugin(ctx, settings.config) as unknown as DesignPluginFace
  // The write path is built from the plugin's own profile entry, and `attach` is
  // what supplies it. Without it the policy has no writer and every settings
  // write silently does nothing — which is exactly how the first version of this
  // spec failed, with the toggle appearing not to take.
  settings.attach(plugin as unknown as object)
  return {
    ctx,
    definitions,
    read: (path: string) => { files.set(path, path.endsWith('dirty.html') ? DIRTY_COMPOSITION : CLEAN_COMPOSITION); return path },
    seed: (path: string, text: string) => { files.set(path, text); return path },
    written: (path: string) => files.get(path),
    dispose: async () => { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) },
    design: plugin,
  }
}

describe('the design pack through the real plugin', () => {
  it('mounts the vendored Skills for real and reports them as ready', async () => {
    forgetMountedSkillRoots('design')
    const world = await withPlugin()
    try {
      // Waits for *both* owners rather than for the first one. The plugin's two
      // packs reconcile independently, so waiting only for "something is
      // published" and then asserting `length === 2` made this test depend on
      // which owner's promise settled first — it passed alone and failed in the
      // full suite, which is the shape of a race rather than of a defect.
      await vi.waitFor(() => {
        expect(mountedPluginSkillRoots().length).toBeGreaterThanOrEqual(2)
      }, { timeout: 10_000, interval: 50 })
      const status = await world.design.designStatus()
      expect(status.designEnabled).toBe(true)
      // Mounted, not merely present: `skillsReady` is the mount's own answer, and
      // a directory that exists while the fiber failed reports the failure here.
      expect(status.skillsReady).toBe(true)
      expect(status.skillsError).toBeUndefined()
      expect(status.features[0]!.id).toBe('hyperframes')
      expect(status.features[0]!.enabled).toBe(true)
      // The catalogue's order, filtered to what registered. All five do here:
      // registration needs no browser and no attachment store, which is what the
      // capability list on the page claims.
      expect(status.features[0]!.tools).toEqual([
        'freecodego_design_keyframes',
        'freecodego_design_lint',
        'freecodego_design_preview',
        'freecodego_design_snapshot',
        'freecodego_design_render',
      ])
      // The root handed to the provider is the vendored one, and it is in the
      // registry the capability map reads. That is the wiring the doubles can
      // only assert about themselves.
      // Two owners, not one: the engineering pack is on by default and publishes
      // its own starter root through the same registry. That the union carries
      // both is the whole point of the registry — an assertion of length 1 here
      // would have passed against the private-list arrangement this replaced.
      const roots = mountedPluginSkillRoots()
      expect(roots).toHaveLength(2)
      const designRoot = roots.find(root => /assets[\\/]design[\\/]skills$/u.test(root))
      expect(designRoot).toBeDefined()
      expect(existsSync(designRoot as string)).toBe(true)
      expect(roots.some(root => /assets[\\/]engineering[\\/]/u.test(root))).toBe(true)
    } finally {
      await world.dispose()
      forgetMountedSkillRoots('design')
    }
  })

  it('registers the catalogue search from the page switch, and it answers from the shipped tables', async () => {
    forgetMountedSkillRoots('design')
    // The catalogue row and *only* it: the point is that the switch on the page is
    // what registered this tool, so a build that also mounted the composition pack
    // would leave the assertion below unable to tell which path did it.
    const world = await withPlugin({ features: ['uiux-catalogue'] })
    try {
      await vi.waitFor(() => {
        expect(world.definitions.map(definition => definition.name)).toContain('freecodego_uiux_search')
      }, { timeout: 10_000, interval: 50 })
      // None of the composition tools, because no row asked for them.
      expect(world.definitions.map(definition => definition.name)).not.toContain('freecodego_design_lint')
      // And no Skills provider: this capability has no asset root. The engineering
      // pack publishes its own starter root by default, so the claim is about the
      // design one rather than about an empty registry.
      expect(mountedPluginSkillRoots().some(root => /assets[\\/]design[\\/]/u.test(root))).toBe(false)

      const status = await world.design.designStatus()
      const row = status.features.find(feature => feature.id === 'uiux-catalogue')!
      expect(row.enabled).toBe(true)
      expect(row.tools).toEqual(['freecodego_uiux_search'])

      // Executed against the real corpus rather than a fixture: a tool that
      // registered but could not find its own CSVs is exactly the state a
      // registration-only assertion would call healthy.
      const tool = world.definitions.find(definition => definition.name === 'freecodego_uiux_search')!
      const answer = await tool.execute(
        { query: 'accessible chart for comparing categories', domain: 'chart' },
        runContext({ signal: new AbortController().signal, agent: { session: { header: { cwd: 'C:/work' } } } }),
      ) as {
        readonly kind: string
        readonly outcome: { readonly kind: string; readonly results: readonly Record<string, string>[] }
      }
      expect(answer.kind).toBe('searched')
      expect(answer.outcome.kind).toBe('ok')
      expect(answer.outcome.results[0]?.['Data Type']).toBe('Compare Categories')

      // The switch is the reverse direction: off, the tool is gone and the row says
      // so — a tool the page calls disabled that still answers is the failure this
      // spec exists to rule out.
      const after = await world.design.designFeatureSetEnabled('uiux-catalogue', false) as {
        readonly features: readonly { readonly id: string; readonly tools: readonly string[]; readonly detail: string }[]
      }
      expect(after.features.find(feature => feature.id === 'uiux-catalogue')!.tools).toEqual([])
      expect(world.definitions.map(definition => definition.name)).not.toContain('freecodego_uiux_search')
    } finally {
      await world.dispose()
      forgetMountedSkillRoots('design')
    }
  })

  it('registers the React Bits row from the page switch, mounts its own Skill root, and fetches through the real tool', async () => {
    forgetMountedSkillRoots('design')
    // The one design row whose knowledge is not in this package: it reads upstream
    // over the network, so the fetch is stubbed here and everything else is real —
    // the plugin, the switch, the registration, the tool definition as the model
    // receives it, and the reader underneath it. A case that only asserted the name
    // registered would pass against a tool that could not parse a single document.
    const world = await withPlugin({ features: ['react-bits'] })
    const index = {
      items: [{
        name: 'CountUp-TS-TW',
        title: 'CountUp',
        description: 'A number that counts up when it enters the viewport.',
        dependencies: [],
        registryDependencies: [],
        files: [{ path: 'CountUp/CountUp.tsx', type: 'registry:component' }],
      }],
    }
    vi.stubGlobal('fetch', async (url: string) => {
      const body = url.endsWith('/r/registry.json')
        ? JSON.stringify(index)
        : JSON.stringify({
          ...index.items[0],
          files: [{ path: 'CountUp/CountUp.tsx', type: 'registry:component', content: "import { useEffect } from 'react'\n\nexport function CountUp() { useEffect(() => undefined, []); return null }\n" }],
        })
      return { ok: true, status: 200, statusText: 'OK', text: async () => body }
    })
    try {
      // Both halves of one reconcile, waited for together: the tool registers before
      // the Skills mount is awaited, so waiting only for the tool would assert the
      // mount while it is still in flight. This row ships a Skill written here rather
      // than vendored, so the mount is half of what it offers — a tool that registered
      // while its root never reached the provider is a row offering half of itself.
      await vi.waitFor(() => {
        expect(world.definitions.map(definition => definition.name)).toContain('freecodego_reactbits')
        expect(mountedPluginSkillRoots().some(root => /assets[\\/]design[\\/]react-bits$/u.test(root))).toBe(true)
      }, { timeout: 10_000, interval: 50 })
      expect(world.definitions.map(definition => definition.name)).not.toContain('freecodego_design_lint')

      const status = await world.design.designStatus()
      const row = status.features.find(feature => feature.id === 'react-bits')!
      expect(row.enabled).toBe(true)
      expect(row.tools).toEqual(['freecodego_reactbits'])
      expect(row.label).toBe('React Bits 动效组件')
      expect(row.available).toBe(true)
      // One paragraph more than the other rows: this is the only one that writes, so
      // the body has to say what a write does — the destination, the confirmation, and
      // the two alterations — before a user switches it on.
      expect(row.summary.split('\n')).toHaveLength(6)
      expect(row.summary).toContain('按需联网')
      // The promise a user is deciding on, in the row's own words: the components are
      // fetched on demand because redistributing them is forbidden, and nothing is
      // written to their project.
      expect(row.summary).toContain('禁止把组件再分发')
      expect(row.detail).toContain('Skill 已就绪')

      const tool = world.definitions.find(definition => definition.name === 'freecodego_reactbits')!
      const searched = await tool.execute(
        { action: 'search', query: 'count' },
        runContext({ signal: new AbortController().signal, agent: { session: { header: { cwd: 'C:/work' } } } }),
      ) as { readonly kind: string; readonly hits: readonly { readonly component: string }[] }
      expect(searched.kind).toBe('catalogue')
      expect(searched.hits.map(hit => hit.component)).toEqual(['CountUp'])

      const fetched = await tool.execute(
        { action: 'get', component: 'count-up' },
        runContext({ signal: new AbortController().signal, agent: { session: { header: { cwd: 'C:/work' } } } }),
      ) as {
        readonly kind: string
        readonly files: readonly { readonly writeAs: string; readonly content?: string }[]
        readonly inspection: { readonly ready: boolean; readonly findings: readonly { readonly id: string }[] }
        readonly license: { readonly forbids: string }
      }
      expect(fetched.kind).toBe('component')
      expect(fetched.files[0]?.writeAs).toBe('CountUp.tsx')
      expect(fetched.files[0]?.content).toContain('export function CountUp')
      // The review ran on the fetched text through the real path, and the licence
      // travelled with it.
      expect(fetched.inspection.findings.map(finding => finding.id)).toContain('client-directive')
      expect(fetched.license.forbids).toContain('再分发')

      // And the write half, through the same registered definition and the plugin's
      // own file service: a refusal first, naming the destination, then the write.
      const refused = await tool.execute(
        { action: 'apply', component: 'CountUp', directory: 'src/components/reactbits' },
        runContext({ signal: new AbortController().signal, agent: { session: { header: { cwd: 'C:/work' } } } }),
      ) as { readonly reason: string; readonly wouldWrite: readonly string[] }
      expect(refused.reason).toBe('confirmation-required')
      expect(refused.wouldWrite).toEqual(['C:/work/src/components/reactbits/CountUp.tsx'])
      expect(world.written('C:/work/src/components/reactbits/CountUp.tsx')).toBeUndefined()

      const applied = await tool.execute(
        { action: 'apply', component: 'CountUp', directory: 'src/components/reactbits', confirm: true, target: 'next' },
        runContext({ signal: new AbortController().signal, agent: { session: { header: { cwd: 'C:/work' } } } }),
      ) as {
        readonly kind: string
        readonly written: readonly { readonly path: string; readonly transformations: readonly { readonly id: string }[] }[]
      }
      expect(applied.kind).toBe('applied')
      expect(applied.written.map(entry => entry.path)).toEqual(['C:/work/src/components/reactbits/CountUp.tsx'])
      expect(applied.written[0]?.transformations.map(change => change.id)).toEqual(['client-directive'])
      // The file that was not there before is now there, with the directive the target
      // framework needs and the component's own source after it.
      const onDisk = world.written('C:/work/src/components/reactbits/CountUp.tsx')
      expect(onDisk?.startsWith("'use client'")).toBe(true)
      expect(onDisk).toContain('export function CountUp')

      // The switch is the reverse direction: off, the tool is gone and the row says
      // so. Nothing was written anywhere on the way in or out — the component exists
      // in the answer and nowhere else.
      const after = await world.design.designFeatureSetEnabled('react-bits', false) as {
        readonly features: readonly { readonly id: string; readonly tools: readonly string[] }[]
      }
      expect(after.features.find(feature => feature.id === 'react-bits')!.tools).toEqual([])
      expect(world.definitions.map(definition => definition.name)).not.toContain('freecodego_reactbits')
    } finally {
      vi.unstubAllGlobals()
      await world.dispose()
      forgetMountedSkillRoots('design')
    }
  })

  it('registers the Impeccable detector from the page switch, and it scans a real file', async () => {
    forgetMountedSkillRoots('design')
    // The detector row and only it, so the switch is provably what registered the
    // tool. `backend: 'builtin'` is passed on the call below, and that is what makes
    // this case independent of the machine it runs on: an installed engine would
    // otherwise change the answer rather than the wiring, and the wiring is the
    // subject here.
    const world = await withPlugin({ features: ['impeccable'] })
    try {
      await vi.waitFor(() => {
        expect(world.definitions.map(definition => definition.name)).toContain('freecodego_design_detect')
      }, { timeout: 10_000, interval: 50 })
      expect(world.definitions.map(definition => definition.name)).not.toContain('freecodego_design_lint')
      expect(mountedPluginSkillRoots().some(root => /assets[\\/]design[\\/]/u.test(root))).toBe(false)

      const status = await world.design.designStatus()
      const row = status.features.find(feature => feature.id === 'impeccable')!
      expect(row.enabled).toBe(true)
      expect(row.tools).toEqual(['freecodego_design_detect'])
      // The three fields the card is made of, as the page receives them: a title, a
      // body that says what is and is not wired, and a status line. A row that
      // rendered with an empty body is a switch nobody can decide on.
      expect(row.label).toBe('Impeccable 设计检测')
      expect(row.available).toBe(true)
      expect(row.summary.split('\n')).toHaveLength(5)
      expect(row.summary).toContain('已接入：`freecodego_design_detect`')
      expect(row.summary).toContain('未接入')
      expect(row.detail).toContain('不挂载 Skill 资源')

      const tool = world.definitions.find(definition => definition.name === 'freecodego_design_detect')!
      const css = [
        'body { font-family: Inter, sans-serif; }',
        '.title { background: linear-gradient(90deg, #a855f7, #ec4899); -webkit-background-clip: text; color: transparent; }',
      ].join('\n')
      const answer = await tool.execute(
        { path: world.seed('C:/work/sloppy.css', css), backend: 'builtin' },
        runContext({ signal: new AbortController().signal, agent: { session: { header: { cwd: 'C:/work' } } } }),
      ) as {
        readonly kind: string
        readonly backend: string
        readonly findings: readonly { readonly rule: string; readonly file?: string }[]
        readonly coverage: { readonly rules: number; readonly of: number }
      }
      expect(answer.kind).toBe('scanned')
      expect(answer.backend).toBe('builtin')
      expect(answer.findings.map(finding => finding.rule)).toEqual(
        expect.arrayContaining(['overused-font', 'gradient-text']),
      )
      // The file it read is the file the call named, and the bound comes back with
      // the answer: a subset that did not say how small it is would read as a clean
      // bill of health.
      expect(answer.findings.every(finding => finding.file === 'C:/work/sloppy.css')).toBe(true)
      expect(answer.coverage.of).toBe(61)
      expect(answer.coverage.rules).toBeGreaterThan(0)

      // The switch is the reverse direction: off, the tool is gone and the row says
      // so, which is the failure this spec exists to rule out.
      const after = await world.design.designFeatureSetEnabled('impeccable', false) as {
        readonly features: readonly { readonly id: string; readonly tools: readonly string[] }[]
      }
      expect(after.features.find(feature => feature.id === 'impeccable')!.tools).toEqual([])
      expect(world.definitions.map(definition => definition.name)).not.toContain('freecodego_design_detect')
    } finally {
      await world.dispose()
      forgetMountedSkillRoots('design')
    }
  })

  it('lists all 17 vendored Skills through a real provider', async () => {
    // Deliberately *not* through the plugin's own mount.
    //
    // The plugin's mount leaves `ctx.skills.list()` empty in a bare `Context`,
    // while reporting the mount as successful — the provider is created and the
    // directory is right, but nothing is indexed. I could not tell from here
    // whether that is `watch: true` waiting for a settle event, a `dshHome` the
    // schema requires and no layer supplies outside the app, or something about
    // `list()`; so the assets are proven where the environment is explicit (the
    // pattern `engineering.spec.ts` uses) and the plugin's own path is claimed
    // only as far as it was observed. Stating the bound is the point: a weaker
    // assertion that passed would look like more evidence than it is.
    const home = await mkdtemp(join(tmpdir(), 'freecodego-design-listing-'))
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      await ctx.plugin({ name: 'test-design-skills', inject: ['skills'], apply: applySkillFilesystem }, {
        providerName: 'freecodego-design-test',
        includeDefaultRoots: false,
        customSkillDirs: [resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'design', 'skills')],
        dshHome: join(home, '.dsh'),
        agentsHome: join(home, '.agents'),
        watch: false,
      } as never)
      const listed = (await (ctx as unknown as { skills: SkillListFace }).skills.list()).map(skill => skill.name)
      expect(listed).toHaveLength(17)
      for (const name of ['hyperframes-core', 'slideshow', 'talking-head-recut', 'music-to-video']) {
        expect(listed).toContain(name)
      }
    } finally {
      await ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('lists the React Bits Skill through a real provider, from the root this repository wrote', async () => {
    // The same pattern as the listing above, over the one Skill root that is not
    // vendored: a file this repository authored has to be a Skill the provider
    // accepts, with the name the model would select it by — otherwise the row's
    // switch mounts a directory that explains nothing, and the licence boundary this
    // Skill carries would only exist in the repository.
    const home = await mkdtemp(join(tmpdir(), 'freecodego-reactbits-listing-'))
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      await ctx.plugin({ name: 'test-reactbits-skills', inject: ['skills'], apply: applySkillFilesystem }, {
        providerName: 'freecodego-reactbits-test',
        includeDefaultRoots: false,
        customSkillDirs: [resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'design', 'react-bits')],
        dshHome: join(home, '.dsh'),
        agentsHome: join(home, '.agents'),
        watch: false,
      } as never)
      const skills = await (ctx as unknown as { skills: SkillListFace }).skills.list()
      expect(skills.map(skill => skill.name)).toEqual(['react-bits'])
      // And it is the Skill's own prose: the licence boundary has to be readable in
      // the body the model is handed, not only in the row on the settings page.
      const body = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'design', 'react-bits', 'SKILL.md'), 'utf8')
      expect(body).toContain('Commons Clause')
      expect(body).toContain('Redistribution is not')
    } finally {
      await ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('lists all 13 vendored Taste Skills through a real provider', async () => {
    // Same bound as the listing two cases up: the pack is proven where the
    // environment is explicit. It matters more here than anywhere else, because this
    // is the only row that ships nothing but prose — a provider that mounts the
    // directory and indexes nothing would leave the switch on with no way for the
    // model to reach anything behind it, and the row's own status would still read
    // `Skill 已就绪`.
    const home = await mkdtemp(join(tmpdir(), 'freecodego-taste-listing-'))
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      await ctx.plugin({ name: 'test-taste-skills', inject: ['skills'], apply: applySkillFilesystem }, {
        providerName: 'freecodego-taste-test',
        includeDefaultRoots: false,
        customSkillDirs: [resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'design', 'taste')],
        dshHome: join(home, '.dsh'),
        agentsHome: join(home, '.agents'),
        watch: false,
      } as never)
      const listed = (await (ctx as unknown as { skills: SkillListFace }).skills.list()).map(skill => skill.name)
      expect(listed).toHaveLength(13)
      // The names are upstream's, not the directory names: a mount keyed by directory
      // would still list thirteen entries and every one of them would be unselectable.
      for (const name of ['design-taste-frontend', 'design-taste-frontend-v1', 'industrial-brutalist-ui', 'high-end-visual-design', 'image-to-code', 'full-output-enforcement']) {
        expect(listed).toContain(name)
      }
      expect(listed).not.toContain('taste-skill')
    } finally {
      await ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('registers the tools through the real tool service, and withdraws them on the switch', async () => {
    forgetMountedSkillRoots('design')
    const world = await withPlugin()
    try {
      await vi.waitFor(() => {
        expect(world.definitions.map(definition => definition.name)).toContain('freecodego_design_lint')
      }, { timeout: 10_000, interval: 50 })
      expect(world.definitions.map(definition => definition.name)).toEqual(
        expect.arrayContaining([
          'freecodego_design_keyframes',
          'freecodego_design_lint',
          'freecodego_design_preview',
          'freecodego_design_snapshot',
          'freecodego_design_render',
        ]),
      )
      const after = await world.design.designFeatureSetEnabled('hyperframes', false) as { readonly features: readonly { readonly tools: readonly string[] }[] }
      expect(after.features[0]!.tools).toEqual([])
      expect(mountedPluginSkillRoots()).toEqual([])
      const listed = await (world.ctx as unknown as { skills: SkillListFace }).skills.list()
      expect(listed.map(skill => skill.name)).not.toContain('hyperframes-core')
    } finally {
      await world.dispose()
      forgetMountedSkillRoots('design')
    }
  })

  it('executes the registered lint tool on a real composition', async () => {
    forgetMountedSkillRoots('design')
    const world = await withPlugin()
    try {
      await vi.waitFor(() => {
        expect(world.definitions.map(definition => definition.name)).toContain('freecodego_design_lint')
      }, { timeout: 10_000, interval: 50 })
      const tool = world.definitions.find(definition => definition.name === 'freecodego_design_lint')!
      const exec = runContext({ signal: new AbortController().signal, agent: { session: { header: { cwd: 'C:/work' } } } })

      const clean = await tool.execute({ path: world.read('C:/work/clean.html') }, exec) as { readonly ok: boolean; readonly bytes: number }
      expect(clean.ok).toBe(true)
      expect(clean.bytes).toBeGreaterThan(0)

      // The failing case is the one that proves the tool is wired to the linter
      // and not to a stub: a finding comes back with its rule id.
      const dirty = await tool.execute({ path: world.read('C:/work/dirty.html') }, exec) as { readonly ok: boolean; readonly findings: readonly { readonly code: string }[] }
      expect(dirty.ok).toBe(false)
      expect(dirty.findings.map(finding => finding.code)).toEqual(
        expect.arrayContaining(['non_deterministic_code', 'root_missing_composition_id']),
      )

      // A path the file service refuses has to surface as that refusal, not as an
      // empty report: an empty report reads as a clean composition.
      await expect(tool.execute({ path: 'C:/work/missing.html' }, exec)).rejects.toThrow(/Could not read the composition/u)
    } finally {
      await world.dispose()
      forgetMountedSkillRoots('design')
    }
  })

  it('serves a composition at a real URL through the registered preview tool', async () => {
    forgetMountedSkillRoots('design')
    const world = await withPlugin()
    try {
      await vi.waitFor(() => {
        expect(world.definitions.map(definition => definition.name)).toContain('freecodego_design_preview')
      }, { timeout: 10_000, interval: 50 })
      const tool = world.definitions.find(definition => definition.name === 'freecodego_design_preview')!
      const exec = runContext({ signal: new AbortController().signal, agent: { session: { header: { cwd: 'C:/work' } } } })

      const served = await tool.execute({ path: world.read('C:/work/clean.html') }, exec) as {
        readonly serving: boolean
        readonly url: string
        readonly compositions: readonly { readonly id: string }[]
      }
      expect(served.serving).toBe(true)
      expect(served.compositions.map(composition => composition.id)).toEqual(['intro'])

      // The claim is that a person can open this, so the test opens it: a listener
      // that answered nothing would satisfy every assertion above.
      const response = await fetch(served.url)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('data-composition-id="intro"')

      // And the port is released when asked, rather than held for the life of the
      // process.
      const stopped = await tool.execute({ path: 'C:/work/clean.html', stop: true }, exec) as { readonly stopped: boolean }
      expect(stopped.stopped).toBe(true)
      await expect(fetch(served.url)).rejects.toThrow()
    } finally {
      await world.dispose()
      forgetMountedSkillRoots('design')
    }
  })

  it('executes the registered keyframes tool and catalogs the animation', async () => {
    forgetMountedSkillRoots('design')
    const world = await withPlugin()
    try {
      await vi.waitFor(() => {
        expect(world.definitions.map(definition => definition.name)).toContain('freecodego_design_keyframes')
      }, { timeout: 10_000, interval: 50 })
      const tool = world.definitions.find(definition => definition.name === 'freecodego_design_keyframes')!
      const value = await tool.execute(
        { path: world.read('C:/work/clean.html') },
        runContext({ signal: new AbortController().signal, agent: { session: { header: { cwd: 'C:/work' } } } }),
      ) as { readonly still: boolean; readonly hasMotion: boolean; readonly targets: readonly string[] }
      expect(value.still).toBe(false)
      expect(value.hasMotion).toBe(true)
      expect(value.targets).toContain('.dot')
    } finally {
      await world.dispose()
      forgetMountedSkillRoots('design')
    }
  })

  it('registers the craft tool from the page switch, and it answers from the vendored layer', async () => {
    forgetMountedSkillRoots('design')
    // The craft row and only it, so the switch is provably what registered the tool
    // — and so the mount assertions below are about a row that has no Skill root at
    // all rather than about one whose root happens not to be mounted.
    const world = await withPlugin({ features: ['craft'] })
    try {
      await vi.waitFor(() => {
        expect(world.definitions.map(definition => definition.name)).toContain('freecodego_design_craft')
      }, { timeout: 10_000, interval: 50 })
      // A row that reads package assets must not drag a Skill mount in with it: the
      // catalogue and the rulebooks are consulted mid-task, not selected before one.
      expect(mountedPluginSkillRoots().some(root => /assets[\\/]design[\\/]/u.test(root))).toBe(false)
      expect(world.definitions.map(definition => definition.name)).not.toContain('freecodego_design_lint')

      const status = await world.design.designStatus()
      const row = status.features.find(feature => feature.id === 'craft')!
      expect(row.enabled).toBe(true)
      expect(row.available).toBe(true)
      expect(row.tools).toEqual(['freecodego_design_craft'])
      expect(row.label).toBe('Craft 工艺规则（上游 11 篇）')
      // The four fields the card is made of, as the page receives them: a title, a
      // body that says what is inside, the live tool list, and a status line. A row
      // that rendered with an empty body is a switch nobody can decide on.
      expect(row.summary.split('\n')).toHaveLength(5)
      expect(row.summary).toContain('freecodego_design_craft')
      expect(row.summary).toContain('exemptions')
      expect(row.detail).toContain('不挂载 Skill 资源')

      const tool = world.definitions.find(definition => definition.name === 'freecodego_design_craft')!
      const exec = runContext({ signal: new AbortController().signal, agent: { session: { header: { cwd: 'C:/work' } } } })

      // `list` is answered from the vendored tree, so the count here is the count of
      // files — a build that lost the assets fails this rather than reporting an
      // empty layer as a valid answer.
      const catalogue = await tool.execute({ action: 'list' }, exec) as {
        readonly kind: string
        readonly sections: readonly { readonly slug: string; readonly bytes: number }[]
        readonly forwardReferences: readonly string[]
      }
      expect(catalogue.kind).toBe('catalogue')
      expect(catalogue.sections.map(section => section.slug)).toContain('typography')
      expect(catalogue.sections.length).toBeGreaterThanOrEqual(11)
      expect(catalogue.sections.every(section => section.bytes > 0)).toBe(true)
      expect(catalogue.forwardReferences).toContain('motion-discipline')

      const got = await tool.execute({ action: 'get', sections: ['color'] }, exec) as {
        readonly kind: string
        readonly sections: readonly { readonly slug: string; readonly text: string }[]
      }
      expect(got.kind).toBe('sections')
      expect(got.sections[0]?.text).toContain('# Color craft rules')
      // A miss is a refusal that names what exists, not an empty success: the caller
      // asked for a rule by name and must not conclude it is in force.
      const miss = await tool.execute({ action: 'get', sections: ['colur'] }, exec) as {
        readonly kind: string
        readonly reason: string
        readonly available: readonly string[]
      }
      expect(miss.kind).toBe('refused')
      expect(miss.reason).toBe('unknown-section')
      expect(miss.available).toContain('color')

      const plan = await tool.execute(
        { action: 'resolve', requires: ['typography'], exemptions: ['typography'] },
        exec,
      ) as { readonly kind: string; readonly load: readonly unknown[]; readonly exempted: readonly string[] }
      expect(plan.kind).toBe('plan')
      expect(plan.load).toEqual([])
      expect(plan.exempted).toEqual(['typography'])

      // The switch is the reverse direction: off, the tool is gone and the row says so.
      const after = await world.design.designFeatureSetEnabled('craft', false) as {
        readonly features: readonly { readonly id: string; readonly tools: readonly string[] }[]
      }
      expect(after.features.find(feature => feature.id === 'craft')?.tools).toEqual([])
      expect(world.definitions.map(definition => definition.name)).not.toContain('freecodego_design_craft')
    } finally {
      await world.dispose()
      forgetMountedSkillRoots('design')
    }
  })
})
