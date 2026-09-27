/**
 * The design pack's tools, and the two that answer from text.
 *
 * The cases that matter here are the ones where a naive implementation is
 * confidently wrong: a linter that reports `Math.random()` inside a string the
 * composition merely *displays*, a linter that flags `new Date(0)` (which is how
 * a composition labels a fixed date), an object-literal splitter that breaks on a
 * nested `{}`, and a tool registry that answers for tools it never registered —
 * or fails to answer for one that is only missing a browser to run.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'

import { DESIGN_FEATURES, IMPECCABLE_FEATURE, REACTBITS_FEATURE, UIUX_CATALOGUE_FEATURE } from '../src/design/features.ts'
import { lintComposition, stripJsComments, stripStringLiterals } from '../src/design/lint.ts'
import { catalogKeyframes } from '../src/design/keyframes.ts'
import { registerDesignTools } from '../src/design/tools.ts'
import { IMPECCABLE_BUILTIN_RULES, scanSource } from '../src/impeccable/rules.ts'
import { pluginTool } from '../src/tool-manifest.ts'

/** A composition that passes every rule this linter implements. */
const CLEAN = [
  '<!doctype html>',
  '<html><head><style>',
  '@keyframes bob { 0% { transform: translateY(0) } 100% { transform: translateY(-8px) } }',
  '.dot { animation: bob 1.2s infinite }',
  '</style></head>',
  '<body>',
  '<div id="stage" data-composition-id="intro" data-width="1280" data-height="720">',
  '<div class="dot">hi</div>',
  '</div>',
  '<script>',
  'gsap.to(".dot", { y: -20, duration: 1, ease: "power2.out", repeat: 2 });',
  'gsap.timeline({ repeat: 0, defaults: { duration: 0.5 } });',
  '</script>',
  '</body></html>',
].join('\n')

describe('lint: the rules that are decidable from the file', () => {
  it('passes a composition with no findings', () => {
    const report = lintComposition(CLEAN)
    expect(report.findings).toEqual([])
    expect(report.ok).toBe(true)
    // The report names the rules that ran, so a missing finding is not read as a
    // clean bill of health for rules that do not exist here.
    expect(report.rulesApplied.length).toBeGreaterThan(5)
  })

  it('reports a root that declares neither an id nor dimensions', () => {
    const report = lintComposition('<html><body><div id="stage"></div></body></html>')
    const codes = report.findings.map(finding => finding.code)
    expect(codes).toContain('root_missing_composition_id')
    expect(codes).toContain('root_missing_dimensions')
    expect(report.ok).toBe(false)
  })

  it('reports non-deterministic code, and every pattern that makes a render diverge', () => {
    const report = lintComposition(
      `<div data-composition-id="x" data-width="1" data-height="1"></div>
       <script>
         const a = Math.random();
         const b = Date.now();
         const c = new Date();
         const d = performance.now();
         gsap.to(".x", { x: "random(-20, 20)" });
     </script>`,
    )
    const labels = report.findings.filter(finding => finding.code === 'non_deterministic_code').length
    // Five distinct patterns: Math.random, Date.now, zero-arg new Date,
    // performance.now, and the GSAP random tween string.
    expect(labels).toBe(5)
  })

  it('does not report code the composition only displays', () => {
    // A snippet block or an explainer about randomness carries the text inside a
    // string literal it never runs. Reporting it would leave no way to clear the
    // finding and still render the snippet.
    const report = lintComposition(
      `<div data-composition-id="x" data-width="1" data-height="1"></div>
       <script>const snippet = "Math.random() and new Date()";</script>`,
    )
    expect(report.findings.map(finding => finding.code)).not.toContain('non_deterministic_code')
  })

  it('does not report a fixed date, which is deterministic', () => {
    const report = lintComposition(
      `<div data-composition-id="x" data-width="1" data-height="1"></div>
       <script>const label = new Date(1_700_000_000_000).getFullYear();</script>`,
    )
    expect(report.findings.map(finding => finding.code)).not.toContain('non_deterministic_code')
  })

  it('reports an unclosed style block, a stuck script, a leaked comment, and a digit-prefixed id', () => {
    const report = lintComposition(
      `<div data-composition-id="x" data-width="1" data-height="1">
         <style>body { color: red }
         <div id="7up">visible</div>
         <p>/* not a comment to HTML */</p>
         <script>const broken = ;</script>
       </div>`,
    )
    const codes = report.findings.map(finding => finding.code)
    expect(codes).toContain('unbalanced_style_tags')
    expect(codes).toContain('id_requires_css_escape')
    expect(codes).toContain('visible_markup_comment')
    expect(codes).toContain('invalid_inline_script_syntax')
  })

  it('reports an asset path that leaves the project, and a host with no id', () => {
    const report = lintComposition(
      `<div data-composition-id="x" data-width="1" data-height="1">
         <img src="../../secrets.png">
         <div data-composition-src="child.html"></div>
       </div>`,
    )
    const codes = report.findings.map(finding => finding.code)
    expect(codes).toContain('invalid_parent_traversal_in_asset_path')
    expect(codes).toContain('host_missing_composition_id')
  })

  it('leaves a URL containing a double slash alone', () => {
    // The comment scanner is the reason this is a case at all: a regex would read
    // the `//` in a URL as the start of a comment and then report garbage.
    expect(stripJsComments('const url = "https://example.com/a"')).toContain('https://example.com/a')
    expect(stripStringLiterals('const a = "hi"; const b = 1;')).toContain('const b = 1;')
  })
})

describe('keyframes: the animation surface without a browser', () => {
  it('catalogs GSAP tweens, the timeline, and CSS keyframes together', () => {
    const report = catalogKeyframes(CLEAN)
    expect(report.still).toBe(false)
    const methods = report.entries.map(entry => entry.method).filter(Boolean)
    expect(methods).toContain('to')
    expect(report.timelines).toHaveLength(1)
    expect(report.timelines[0]!.repeat).toBe('0')
    expect(report.cssKeyframes).toEqual([{ name: 'bob', stops: ['0%', '100%'] }])
    // The CSS animation's rule is an entry of its own, pointing at the block.
    const css = report.entries.find(entry => entry.kind === 'css-animation')
    expect(css?.keyframes).toBe('bob')
    expect(css?.repeat).toBe('infinite')
  })

  it('separates motion in space from a change of look', () => {
    const report = catalogKeyframes(
      `<script>gsap.to(".a", { opacity: 0, duration: 1 }); gsap.to(".b", { xPercent: -50, rotation: 90 });</script>`,
    )
    const fading = report.entries.find(entry => entry.target === '.a')
    const moving = report.entries.find(entry => entry.target === '.b')
    expect(fading?.moves).toBe(false)
    expect(moving?.moves).toBe(true)
    expect(report.transformProperties).toEqual(['xPercent', 'rotation'])
    expect(report.targets).toEqual(['.a', '.b'])
    expect(report.hasMotion).toBe(true)
  })

  it('survives a nested object inside the vars argument', () => {
    // `gsap.to(".a", { x: 1, scrollTrigger: { trigger: ".a", start: "top" }, y: 2 })`
    // has one top-level comma pair per property and three commas inside the nested
    // object. A plain split on `,` reports a mangled property set.
    const report = catalogKeyframes(
      `<script>gsap.to(".a", { x: 1, scrollTrigger: { trigger: ".a", start: "top top", end: "bottom" }, y: 2, duration: 0.4 });</script>`,
    )
    const entry = report.entries[0]!
    expect(entry.properties.x).toBe('1')
    expect(entry.properties.y).toBe('2')
    expect(entry.duration).toBe('0.4')
    expect(entry.transforms).toContain('x')
    expect(entry.transforms).toContain('y')
  })

  it('reads a chained timeline position and calls nothing a still that is not', () => {
    const report = catalogKeyframes(
      `<script>const tl = gsap.timeline(); tl.from(".a", { opacity: 0 }, 0.5).to(".b", { x: 10 }, "<");</script>`,
    )
    expect(report.entries.map(entry => entry.method)).toEqual(['from', 'to'])
    expect(report.entries[0]!.position).toBe('0.5')
    expect(report.still).toBe(false)
  })

  it('counts CSS transform keyframes as spatial motion', () => {
    const report = catalogKeyframes(`
      <style>
        @keyframes drift { from { transform: translateX(0) } to { transform: translateX(20px) } }
        .dot { animation: drift 1s infinite }
      </style>
    `)
    const animation = report.entries.find(entry => entry.kind === 'css-animation')
    expect(animation?.moves).toBe(true)
    expect(animation?.transforms).toEqual(['transform'])
    expect(report.transformProperties).toEqual(['transform'])
    expect(report.hasMotion).toBe(true)
    expect(report.still).toBe(false)
  })

  it('does not confuse appearance-only CSS animation or text in CSS with spatial motion', () => {
    const report = catalogKeyframes(`
      <style>
        @keyframes fade {
          from { opacity: 0; content: "transform: scale(2)"; }
          /* transform: translateX(100px); */
          to { opacity: 1; }
        }
        @keyframes contentOnly { from { content: ""; } to { content: "transform: scale(2)"; } }
        .label { animation: contentOnly 1s }
        .caption { animation: fade 1s }
      </style>
    `)
    const animation = report.entries.find(entry => entry.kind === 'css-animation')
    expect(animation?.moves).toBe(false)
    expect(animation?.transforms).toEqual([])
    expect(report.hasMotion).toBe(false)
    expect(report.still).toBe(false)
  })

  it('does not classify immediate GSAP state writes or empty timeline setup as animation', () => {
    const report = catalogKeyframes(`
      <script>
        gsap.set('.dot', { x: 20 });
        gsap.timeline({ repeat: 0 });
      </script>
    `)
    expect(report.entries.map(entry => entry.method)).toEqual(['set'])
    expect(report.entries[0]?.moves).toBe(false)
    expect(report.timelines).toEqual([{ repeat: '0', defaults: { repeat: '0' } }])
    expect(report.hasMotion).toBe(false)
    expect(report.still).toBe(true)
  })

  it('calls a composition with no animation a still', () => {
    const report = catalogKeyframes('<div data-composition-id="x"></div>')
    expect(report.still).toBe(true)
    expect(report.hasMotion).toBe(false)
  })
})

/**
 * What these cases read off a definition that reached the tool service.
 *
 * Wider than a name because one of them asks which tool answered to a name — a
 * definition under the right name with the wrong schema would satisfy a
 * name-only check — and narrowed to three optional fields so the fake stays a
 * fake rather than a second copy of the definition shape.
 */
interface RegisteredDefinition {
  readonly name?: string
  readonly description?: string
  readonly parameters?: { readonly properties?: Readonly<Record<string, unknown>> }
}

describe('tool registration', () => {
  /** A ctx whose two services are whatever the case needs. */
  function fakeContext(options: { readonly tools?: boolean; readonly read?: string } = {}): {
    readonly ctx: { get(name: string): unknown }
    readonly registered: readonly RegisteredDefinition[]
  } {
    const registered: RegisteredDefinition[] = []
    return {
      ctx: {
        get: (name: string) => {
          if (name === 'tools') {
            if (options.tools === false) return undefined
            return { register: (tool: RegisteredDefinition) => { registered.push(tool); return () => undefined } }
          }
          if (name === 'fs') return { resolve: async (path: string) => path, readText: async () => options.read ?? '' }
          return undefined
        },
      },
      registered,
    }
  }

  it('registers every name the feature catalogue declares', () => {
    const world = fakeContext()
    const result = registerDesignTools({ ctx: world.ctx as never, toolPrefix: 'freecodego_' }, [
      'freecodego_design_keyframes',
      'freecodego_design_lint',
      'freecodego_design_render',
      'freecodego_design_preview',
      'freecodego_design_snapshot',
    ])
    // Registration is not execution: a browser and an attachment store are only
    // needed when a tool runs, so all five register on a host that has neither.
    // The order is the table's, which is why it is asserted as equality — the
    // pair check that says a name reached the registered set rather than the
    // catalogue being quietly believed.
    expect(result.registered).toEqual([
      'freecodego_design_keyframes',
      'freecodego_design_lint',
      'freecodego_design_preview',
      'freecodego_design_snapshot',
      'freecodego_design_render',
    ])
    expect(world.registered.map(tool => tool.name)).toEqual(result.registered)
  })

  it('registers the catalogue search the design page offers, under the name the page lists', () => {
    const world = fakeContext()
    // Driven by the catalogue rather than by a literal here: the row on the design
    // page and this table are two halves of one statement, so a name that moves in
    // one of them is a row that offers a tool nothing answers to.
    const result = registerDesignTools({ ctx: world.ctx as never, toolPrefix: 'freecodego_' }, [...UIUX_CATALOGUE_FEATURE.tools])
    expect(result.registered).toEqual([...UIUX_CATALOGUE_FEATURE.tools])
    expect(world.registered.map(tool => tool.name)).toEqual([...UIUX_CATALOGUE_FEATURE.tools])
    // The definition that reached the tool service is the catalogue search and
    // not a composition tool under that name: it takes no `path`, and it says what
    // it reads. A row whose name resolved to something else would still register.
    const definition = world.registered[0]
    expect(definition).toBeDefined()
    expect(definition?.parameters?.properties).not.toHaveProperty('path')
    expect(definition?.description).toContain('never reads or writes the project workspace')
  })

  it('registers the Impeccable detector under the name the page lists, with its own schema', () => {
    const world = fakeContext()
    // Same pair check as the catalogue above, for the other row that ships a tool
    // without Skills: the catalogue row and the implementation table are one
    // statement about one name, and a name that moves in one of them is a row
    // offering a tool nothing answers to.
    const result = registerDesignTools({ ctx: world.ctx as never, toolPrefix: 'freecodego_' }, [...IMPECCABLE_FEATURE.tools])
    expect(result.registered).toEqual([...IMPECCABLE_FEATURE.tools])
    expect(world.registered.map(tool => tool.name)).toEqual([...IMPECCABLE_FEATURE.tools])
    const definition = world.registered[0]
    // The detector and not a composition tool under that name: it takes a `path`
    // that may be a directory or a URL, it reports which backend answered, and it
    // says what it never does. A row whose name resolved to something else would
    // still register.
    expect(definition?.parameters?.properties).toHaveProperty('path')
    expect(definition?.parameters?.properties).toHaveProperty('backend')
    expect(definition?.description).toContain('never writes, downloads, or installs anything')
  })

  it('registers the React Bits tool under the name the page lists, without touching the workspace', () => {
    const world = fakeContext()
    // The third row that offers a tool of its own. This one is the only design tool
    // that reads the network, which is why the definition has to carry that fact and
    // the licence boundary into the model's view rather than leaving both to prose on
    // a settings page the model never reads.
    const result = registerDesignTools({ ctx: world.ctx as never, toolPrefix: 'freecodego_' }, [...REACTBITS_FEATURE.tools])
    expect(result.registered).toEqual([...REACTBITS_FEATURE.tools])
    expect(world.registered.map(tool => tool.name)).toEqual([...REACTBITS_FEATURE.tools])
    const definition = world.registered[0]
    // React Bits and not a composition tool under that name: it takes an action
    // rather than a path, it names the registry it reads, and it states that nothing
    // is installed or written. A row whose name resolved to something else would
    // still register.
    expect(definition?.parameters?.properties).toHaveProperty('action')
    expect(definition?.parameters?.properties).not.toHaveProperty('path')
    // The write half of the row is spelled out on the definition, because that is
    // where the model sees it: a destination and a confirmation are both required,
    // and the two alterations are named rather than left to be discovered in a diff.
    expect(definition?.parameters?.properties).toHaveProperty('directory')
    expect(definition?.parameters?.properties).toHaveProperty('confirm')
    expect(definition?.description).toContain('reactbits.dev')
    expect(definition?.description).toContain('Nothing is ever installed')
    expect(definition?.description).toContain('requires confirm: true')
  })

  it('warns on the card before a writing tool is switched on, in the manifest\u2019s own terms', () => {
    // Two declarations about one tool that never read each other: `capability` in
    // `tool-manifest.ts` is what *holding* the name needs, which is the axis Plan
    // Mode and `verify-on-stop` answer by, and the row's summary is what a user
    // reads before switching the capability on. A tool that may write the workspace
    // under a card that reads as read-only is a switch taken under a wrong
    // description. Driven by the manifest rather than by a literal, so the next
    // writing tool is covered by the day it is declared — and the guard below keeps
    // the loop from passing vacuously if the writing row ever loses that capability.
    expect(DESIGN_FEATURES.some(feature => feature.tools.some(tool => pluginTool(tool)?.capability === 'write'))).toBe(true)
    for (const feature of DESIGN_FEATURES) {
      const writes = feature.tools.some(tool => pluginTool(tool)?.capability === 'write')
      if (!writes) continue
      expect(feature.summary, feature.id).toContain('写入')
    }
  })

  it('states the rule count it actually implements, rather than a number typed beside it', () => {
    // The card says how much of upstream's catalogue answers here, which is the
    // sentence a user decides on. The number is interpolated from the rules module
    // rather than written into the prose, and this is the pair check: a rule added
    // to the table changes the card, and a card that quoted a stale count fails
    // here instead of misleading a reader.
    expect(IMPECCABLE_FEATURE.summary).toContain(`${String(IMPECCABLE_BUILTIN_RULES.length)} 条规则`)
    expect(IMPECCABLE_BUILTIN_RULES.length).toBe(scanSource('a.css', '').rulesApplied.length)
    expect(new Set(IMPECCABLE_BUILTIN_RULES).size).toBe(IMPECCABLE_BUILTIN_RULES.length)
    // And it is a subset of what upstream publishes, named as such on the card: a
    // number larger than upstream's would be a claim about rules that do not exist.
    expect(IMPECCABLE_BUILTIN_RULES.length).toBeLessThan(61)
  })

  it('registers only the names it was asked for', () => {
    // The feature catalogue is the caller's statement about what this capability
    // provides; a name it does not list must not reach the tool service even
    // though the implementation exists.
    const world = fakeContext()
    const result = registerDesignTools({ ctx: world.ctx as never, toolPrefix: 'freecodego_' }, ['freecodego_design_lint'])
    expect(result.registered).toEqual(['freecodego_design_lint'])
  })

  it('registers nothing when the tools service is absent, instead of throwing', () => {
    const world = fakeContext({ tools: false })
    const result = registerDesignTools({ ctx: world.ctx as never, toolPrefix: 'freecodego_' }, ['freecodego_design_lint'])
    expect(result.registered).toEqual([])
  })

  it('hands back a disposer that shuts the preview server down', async () => {
    const world = fakeContext()
    const result = registerDesignTools({ ctx: world.ctx as never, toolPrefix: 'freecodego_' }, ['freecodego_design_preview'])
    // The preview outlives its call — that is what a preview is — so the pack's
    // stand-down has to close the listener. One handle per registration set, and
    // it is on the list the registry disposes.
    expect(result.registrations).toHaveLength(2)
    for (const registration of result.registrations) {
      if (typeof registration === 'function') registration()
      else await registration.dispose?.()
    }
  })

  it('reads a relative path against the session working directory', async () => {
    let seen = ''
    const tools: { readonly name?: string; execute?: (args: unknown, exec: unknown) => Promise<unknown> }[] = []
    const ctx = {
      get: (name: string) => {
        if (name === 'tools') return { register: (tool: never) => { tools.push(tool); return () => undefined } }
        if (name === 'fs') {
          return {
            resolve: async (path: string) => { seen = path; return path },
            readText: async () => CLEAN,
          }
        }
        return undefined
      },
    }
    registerDesignTools({ ctx: ctx as never, toolPrefix: 'freecodego_' }, ['freecodego_design_lint'])
    const tool = tools[0]!
    await tool.execute?.({ path: 'comps/intro.html' }, { agent: { session: { header: { cwd: 'C:/work/proj' } } } })
    // Resolving against the plugin's own cwd would read a different file the
    // moment a session opened a workspace.
    expect(seen).toBe('C:/work/proj/comps/intro.html')
  })

  it('refuses when there is no file service rather than reaching around it', async () => {
    const tools: { execute?: (args: unknown, exec: unknown) => Promise<unknown> }[] = []
    const ctx = { get: (name: string) => (name === 'tools' ? { register: (tool: never) => { tools.push(tool); return () => undefined } } : undefined) }
    registerDesignTools({ ctx: ctx as never, toolPrefix: 'freecodego_' }, ['freecodego_design_keyframes'])
    await expect(tools[0]!.execute?.({ path: 'a.html' }, {})).rejects.toThrow(/no file service/u)
  })
})
