/**
 * The React Bits registry reader, and the licence position it exists to keep.
 *
 * Two properties are worth a spec of their own here, because both are promises a
 * user reads on the design page rather than implementation details:
 *
 *  - **Nothing is written to disk.** The components are read from upstream on
 *    demand and returned to the caller, because a copy in this package's assets —
 *    or in a cache file, which is the same copy under another name — is the
 *    redistribution their licence forbids. The case below reads this module's own
 *    source to check it has no filesystem import at all, which is the one way to
 *    keep that promise from silently eroding as the module grows.
 *  - **A document this reader does not understand is reported, not summarized into
 *    silence.** Upstream's shape is shadcn's, which is not this package's to
 *    change, so a missing `items` array or an SPA shell where a registry item was
 *    expected has to surface as a reason rather than as an empty catalogue.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/reactbits-registry
 */

import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { stripJsComments } from '../src/design/lint.ts'

import {
  REACTBITS_INDEX_URL,
  ReactBitsCatalogue,
  parseVariantName,
  reactbitsItemUrl,
  readRegistryIndex,
  readRegistryItem,
  resolveComponent,
  searchCatalogue,
  slugifyTitle,
  variantName,
  type ReactBitsFetcher,
  type ReactBitsIndexEntry,
} from '../src/reactbits/registry.ts'

/** One index row, with only the fields this reader understands. */
function row(name: string, title: string, overrides: Partial<ReactBitsIndexEntry> = {}): ReactBitsIndexEntry {
  return { name, title, description: `${title} as a fixture.`, dependencies: [], registryDependencies: [], files: [{ path: `${title}/${title}.tsx`, type: 'registry:component' }], ...overrides }
}

/** The fixture catalogue: a component with two variants, a plain-CSS one, a heavy one, and one plain component. */
const INDEX: { readonly items: readonly ReactBitsIndexEntry[]; readonly [key: string]: unknown } = {
  $schema: 'https://ui.shadcn.com/schema/registry.json',
  name: '@react-bits',
  homepage: 'https://reactbits.dev',
  items: [
    row('CountUp-TS-TW', 'CountUp', { description: 'A number that counts up when it enters the viewport.' }),
    row('CountUp-JS-CSS', 'CountUp', { description: 'A number that counts up when it enters the viewport.' }),
    row('SplitText-TS-CSS', 'SplitText', { description: 'Splits text so it can be animated.', dependencies: ['gsap@^3.13.0'], files: [{ path: 'SplitText/SplitText.tsx', type: 'registry:component' }, { path: 'SplitText/SplitText.css', type: 'registry:style' }] }),
    row('SkyBeam-TS-TW', 'SkyBeam', { description: 'A WebGL light beam background.', dependencies: ['three@^0.170.0', 'postprocessing@^6.36.0'] }),
    row('GhostText-TS-TW', 'GhostText', { description: 'A blurry text reveal.', dependencies: ['motion@^12.23.12'] }),
  ],
}

/** The contents a fetched item document carries for a component. */
const CONTENTS: Readonly<Record<string, string>> = {
  CountUp: 'export function CountUp() { return null }\n',
  SplitText: "import { gsap } from 'gsap'\n\nexport function SplitText() { return null }\n",
  SkyBeam: 'export function SkyBeam() { return null }\n',
  GhostText: 'export function GhostText() { return null }\n',
}

/**
 * A fetch that answers from the fixture.
 *
 * The whole reader is exercised through this seam, so no case in this file needs
 * the network — which is also what keeps the suite runnable on a machine that has
 * none, exactly as the design page's own claim about this row requires of the
 * user's machine for the row to be useful at all.
 */
const serve: ReactBitsFetcher = async (url) => {
  if (url === REACTBITS_INDEX_URL) return JSON.stringify(INDEX)
  const name = url.slice(reactbitsItemUrl('').length)
  const entry = INDEX.items.find(item => item.name === name)
  if (entry === undefined) return '<!doctype html><html><body>React Bits</body></html>'
  return JSON.stringify({
    ...entry,
    files: entry.files.map(file => (file.path.endsWith('.css')
      ? { ...file, type: 'registry:style', content: '.split { display: block }\n' }
      : { ...file, content: CONTENTS[entry.title] ?? '' })),
  })
}

describe('reading the index', () => {
  it('reads every entry the document carries, and reads the fields it needs', async () => {
    const read = await readRegistryIndex(REACTBITS_INDEX_URL, serve)
    expect(read.failure).toBeUndefined()
    expect(read.unexpectedShape).toBeUndefined()
    expect(read.value).toHaveLength(5)
    expect(read.value?.[0]).toMatchObject({
      name: 'CountUp-TS-TW',
      title: 'CountUp',
      dependencies: [],
      files: [{ path: 'CountUp/CountUp.tsx', type: 'registry:component' }],
    })
  })

  it('reads the catalogue from the URL its own constant names', async () => {
    const asked: string[] = []
    await readRegistryIndex(REACTBITS_INDEX_URL, async (url) => { asked.push(url); return JSON.stringify(INDEX) })
    // The constant is the statement — `https://reactbits.dev/r/registry.json` — so a
    // case that reads the same constant twice proves nothing. Spelled here, once.
    expect(asked).toEqual(['https://reactbits.dev/r/registry.json'])
  })

  it('skips a row it cannot name rather than inventing one', async () => {
    const read = await readRegistryIndex(REACTBITS_INDEX_URL, async () => JSON.stringify({
      items: [row('CountUp-TS-TW', 'CountUp'), { description: 'no name, no title' }, { name: 'nameless' }],
    }))
    expect(read.value?.map(entry => entry.name)).toEqual(['CountUp-TS-TW'])
    // And a document whose rows were *all* unusable is reported as an unrecognized
    // shape rather than as a catalogue with nothing in it: an empty catalogue would
    // be answered as "no match", which reads as a search that ran.
    const unusable = await readRegistryIndex(REACTBITS_INDEX_URL, async () => JSON.stringify({ items: [{ description: 'nothing' }] }))
    expect(unusable.value).toBeUndefined()
    expect(unusable.unexpectedShape).toContain('no entry with a name and a title')
  })

  it('tells a failed fetch from a document it does not understand', async () => {
    const thrown = await readRegistryIndex(REACTBITS_INDEX_URL, async () => { throw new Error('HTTP 503 Service Unavailable') })
    expect(thrown.failure).toContain('HTTP 503')
    expect(thrown.unexpectedShape).toBeUndefined()

    const notJson = await readRegistryIndex(REACTBITS_INDEX_URL, async () => '<html>nope</html>')
    expect(notJson.failure).toBeUndefined()
    expect(notJson.unexpectedShape).toContain('not JSON')

    const wrongShape = await readRegistryIndex(REACTBITS_INDEX_URL, async () => JSON.stringify({ name: 'react-bits', items: 'later' }))
    expect(wrongShape.unexpectedShape).toContain('no `items` array')
  })
})

describe('reading one variant', () => {
  it('returns the files with their contents, which is what the caller copies', async () => {
    const read = await readRegistryItem('SplitText-TS-CSS', serve)
    expect(read.url).toBe(reactbitsItemUrl('SplitText-TS-CSS'))
    expect(read.value?.dependencies).toEqual(['gsap@^3.13.0'])
    expect(read.value?.files).toEqual([
      { path: 'SplitText/SplitText.tsx', type: 'registry:component', content: CONTENTS.SplitText },
      { path: 'SplitText/SplitText.css', type: 'registry:style', content: '.split { display: block }\n' },
    ])
  })

  it('reports an unknown variant the way upstream answers one', async () => {
    // Upstream's site answers an unknown path with its application shell. That is
    // not JSON, and the message says so rather than leaving the caller to wonder
    // whether they hit a network problem.
    const read = await readRegistryItem('NoSuchThing-TS-TW', serve)
    expect(read.value).toBeUndefined()
    expect(read.unexpectedShape).toContain('not JSON')
    expect(read.unexpectedShape).toContain('unknown variant')
  })

  it('drops a file that carries no content, and reports a document with none left', async () => {
    const read = await readRegistryItem('CountUp-TS-TW', async () => JSON.stringify({
      ...row('CountUp-TS-TW', 'CountUp'),
      files: [{ path: 'CountUp/CountUp.tsx', type: 'registry:component' }],
    }))
    expect(read.value).toBeUndefined()
    expect(read.unexpectedShape).toContain('no file with contents')
  })
})

describe('the naming grammar', () => {
  it('reads a variant name from the end, because a component name may contain dashes', () => {
    expect(parseVariantName('CountUp-TS-TW')).toEqual({ component: 'CountUp', language: 'ts', style: 'tailwind', name: 'CountUp-TS-TW' })
    expect(parseVariantName('Animated-List-TS-CSS')).toEqual({ component: 'Animated-List', language: 'ts', style: 'css', name: 'Animated-List-TS-CSS' })
    // Not variants: no component, an unknown language, an unknown style.
    expect(parseVariantName('CountUp-TS')).toBeUndefined()
    expect(parseVariantName('-TS-TW')).toBeUndefined()
    expect(parseVariantName('CountUp-XX-TW')).toBeUndefined()
    expect(parseVariantName('CountUp-TS-SASS')).toBeUndefined()
  })

  it('spells a variant name the way the registry does', () => {
    expect(variantName('CountUp', 'ts', 'tailwind')).toBe('CountUp-TS-TW')
    expect(variantName('CountUp', 'js', 'css')).toBe('CountUp-JS-CSS')
  })

  it('slugs an acronym run the way the docs page does', () => {
    // Upstream lists `ASCIIText` at `ascii-text`, so a slug that only split on a
    // lower-to-upper boundary would produce `asciitext` and fail to resolve the very
    // name a reader copied out of the documentation.
    expect(slugifyTitle('ASCIIText')).toBe('ascii-text')
    expect(slugifyTitle('CountUp')).toBe('count-up')
    expect(slugifyTitle('3DMarquee')).toBe('3-d-marquee')
  })

  it('resolves a variant name, a component name and a docs slug to one component', () => {
    const entries = INDEX.items
    const names = ['CountUp-TS-TW', 'CountUp', 'count-up']
    for (const query of names) {
      const resolution = resolveComponent(entries, query)
      expect(resolution.component).toBe('CountUp')
      expect(resolution.exact).toBe(true)
      expect(resolution.candidates.map(entry => entry.name).sort()).toEqual(['CountUp-JS-CSS', 'CountUp-TS-TW'])
    }
  })

  it('offers candidates rather than choosing between components a keyword only partly names', () => {
    const resolution = resolveComponent(INDEX.items, 'text')
    expect(resolution.exact).toBe(false)
    expect(new Set(resolution.candidates.map(entry => entry.title))).toEqual(new Set(['SplitText', 'GhostText']))
  })
})

describe('searching the catalogue', () => {
  it('folds a component\\u2019s variants into one row, with what they require between them', () => {
    const report = searchCatalogue(INDEX.items, 'count', { limit: 8 })
    expect(report.inspected).toBe(5)
    expect(report.matched).toBe(1)
    expect(report.hits[0]).toMatchObject({
      title: 'CountUp',
      variants: ['CountUp-TS-TW', 'CountUp-JS-CSS'],
      dependencies: [],
      requiresNothing: true,
    })
  })

  it('unions the dependencies across variants, because a variant can carry its own', () => {
    const report = searchCatalogue([
      row('Widget-TS-CSS', 'Widget', { dependencies: ['gsap@^3.13.0'] }),
      row('Widget-TS-TW', 'Widget', { dependencies: ['motion@^12.23.12'] }),
    ], 'widget', { limit: 8 })
    // Sorted, so a caller reading one line sees the same set every time.
    expect(report.hits[0]?.dependencies).toEqual(['gsap@^3.13.0', 'motion@^12.23.12'])
    expect(report.hits[0]?.requiresNothing).toBe(false)
  })

  it('requires every word of a multi-word keyword, and reads the description too', () => {
    expect(searchCatalogue(INDEX.items, 'webgl background', { limit: 8 }).hits.map(hit => hit.title)).toEqual(['SkyBeam'])
    expect(searchCatalogue(INDEX.items, 'viewport number', { limit: 8 }).hits.map(hit => hit.title)).toEqual(['CountUp'])
    expect(searchCatalogue(INDEX.items, 'webgl viewport', { limit: 8 }).hits).toEqual([])
  })

  it('finds a variant name this tool accepts everywhere else', () => {
    // `get` and `apply` both take `CountUp-TS-TW`. A search that answered
    // "nothing matched" for the string the same tool asks for would be refusing
    // its own vocabulary, so the name is matched whole.
    const report = searchCatalogue(INDEX.items, 'countup-ts-tw', { limit: 8 })
    expect(report.hits.map(hit => hit.title)).toEqual(['CountUp'])
    expect(report.matched).toBe(1)
  })

  it('matches a name whole rather than by substring, so a variant token is not a query for everything', () => {
    const catalogue = [
      row('Widget-TS-TW', 'Widget', { description: 'A fixture.' }),
      row('Widget-JS-CSS', 'Widget', { description: 'A fixture.' }),
    ]
    // `-TS-` and `-TW-` are variant tokens rather than words, and every
    // component carries one of each pair: reading them as substrings would make
    // the query `ts` name the entire catalogue and the query `widget-t` name
    // nothing an author would recognize as a search.
    expect(searchCatalogue(catalogue, 'ts', { limit: 8 }).hits).toEqual([])
    expect(searchCatalogue(catalogue, 'widget-ts', { limit: 8 }).hits).toEqual([])
    expect(searchCatalogue(catalogue, 'widget-ts-tw', { limit: 8 }).hits.map(hit => hit.title)).toEqual(['Widget'])
  })

  it('puts the components that need no package first, then alphabetises', () => {
    const report = searchCatalogue([
      row('Zed-TS-TW', 'Zed', { dependencies: ['three@^0.170.0'] }),
      row('Alpha-TS-TW', 'Alpha', { dependencies: ['three@^0.170.0'] }),
      row('Midway-TS-TW', 'Midway', { dependencies: [] }),
    ], '', { limit: 8 })
    // The cheapest thing to try is the first thing to read: a caller looking for a
    // small effect should not have to page past three WebGL wrappers.
    expect(report.hits.map(hit => hit.title)).toEqual(['Midway', 'Alpha', 'Zed'])
  })

  it('applies the limit and still reports how many matched', () => {
    const report = searchCatalogue(INDEX.items, '', { limit: 2 })
    expect(report.hits).toHaveLength(2)
    expect(report.matched).toBe(4)
  })

  it('keeps only dependency-free components when asked', () => {
    const report = searchCatalogue(INDEX.items, '', { limit: 8, dependencyFree: true })
    expect(report.hits.map(hit => hit.title)).toEqual(['CountUp'])
  })
})

describe('the catalogue reader', () => {
  it('fetches the index once inside its window, and again after it', async () => {
    let calls = 0
    let clock = 1_000_000
    const catalogue = new ReactBitsCatalogue(async () => { calls += 1; return JSON.stringify(INDEX) }, () => clock)
    await catalogue.index()
    await catalogue.index()
    expect(calls).toBe(1)
    // Five minutes later the answer is remeasured: a component published during a
    // long session should be findable without restarting anything.
    clock += 5 * 60 * 1000
    await catalogue.index()
    expect(calls).toBe(2)
  })

  it('refetches the component itself every time, because a stale copy is worse than a request', async () => {
    let calls = 0
    const catalogue = new ReactBitsCatalogue(async (url) => { calls += 1; return serve(url) })
    await catalogue.item('CountUp-TS-TW')
    await catalogue.item('CountUp-TS-TW')
    expect(calls).toBe(2)
  })

  it('forgets what it held on request', async () => {
    let calls = 0
    const catalogue = new ReactBitsCatalogue(async () => { calls += 1; return JSON.stringify(INDEX) })
    await catalogue.index()
    catalogue.clear()
    await catalogue.index()
    expect(calls).toBe(2)
  })
})

describe('the licence position is structural, not a comment', () => {
  it('this module imports no filesystem module at all', async () => {
    // A cache with a path is a bundle under another name, and the promise on the
    // design page is that no component source is stored. The strongest form of that
    // promise this module can carry is having no way to write one.
    const source = stripJsComments(await readFile(new URL('../src/reactbits/registry.ts', import.meta.url), 'utf8'))
    expect(source).not.toMatch(/from 'node:fs'/u)
    expect(source).not.toMatch(/require\('node:fs'\)/u)
    expect(source).not.toMatch(/\bwriteFile/u)
    // And no *code* addresses a path inside this package: the components' destination
    // is the caller's project, so nothing here has a place to put them. The assertion
    // reads the source with its comments removed, because the header's job is to
    // explain why `assets/` is the wrong home and a rule that gagged it would trade
    // the reasoning for the check.
    expect(source).not.toMatch(/['"`]assets\//u)
  })

  it('the tool and the review hold the same line', async () => {
    for (const file of ['../src/reactbits/tool.ts', '../src/reactbits/inspect.ts', '../src/reactbits/imports.ts']) {
      const source = stripJsComments(await readFile(new URL(file, import.meta.url), 'utf8'))
      expect(source, file).not.toMatch(/from 'node:fs'/u)
      expect(source, file).not.toMatch(/['"`]assets\//u)
    }
  })
})
