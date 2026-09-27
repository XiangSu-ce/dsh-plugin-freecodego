/**
 * The React Bits tool, as the model sees it.
 *
 * Three things this file exists to hold, in the order a user would care about
 * them:
 *
 *  - **The fetch is the only side effect.** The tool is built with no context at
 *    all — no file service, no browser, no attachment store — and a case below
 *    calls it that way, because a tool that quietly needed one of those would fail
 *    on exactly the installations the design row promises it works on.
 *  - **The result says what it is.** `search` returns index rows and no source;
 *    `get` returns source and the licence's own two sentences; neither installs
 *    anything, and the notes name the packages rather than running a package
 *    manager against a project this tool cannot see.
 *  - **A name that names nothing is refused with the names that exist.** The
 *    registry's grammar is not the documentation's spelling, so a miss has to be
 *    answerable — otherwise the caller guesses again.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/reactbits-tool
 */

import { describe, expect, it } from 'vitest'

import {
  REACTBITS_INDEX_URL,
  ReactBitsCatalogue,
  reactbitsItemUrl,
  type ReactBitsFetcher,
} from '../src/reactbits/registry.ts'
import { REACTBITS_TOOL_NAME, reactbitsToolDefinition, type ReactBitsFileService } from '../src/reactbits/tool.ts'

/** One index row. */
function row(name: string, title: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, title, description: `${title} as a fixture.`, dependencies: [], registryDependencies: [], files: [{ path: `${title}/${title}.tsx`, type: 'registry:component' }], ...overrides }
}

/** The fixture catalogue. */
const INDEX = {
  items: [
    row('CountUp-TS-TW', 'CountUp', { files: [{ path: 'CountUp/CountUp.tsx', type: 'registry:component' }, { path: 'CountUp/useCountUp.ts', type: 'registry:lib' }] }),
    row('CountUp-TS-CSS', 'CountUp'),
    row('SplitText-TS-CSS', 'SplitText', { dependencies: ['gsap@^3.13.0'], files: [{ path: 'SplitText/SplitText.tsx' }, { path: 'SplitText/SplitText.css' }] }),
    row('GhostText-TS-TW', 'GhostText', { dependencies: ['motion@^12.23.12'] }),
  ],
}

/** The source each component's file carries. */
const SOURCE: Readonly<Record<string, string>> = {
  CountUp: [
    "import { useEffect } from 'react'",
    "import { useCountUp } from './useCountUp'",
    '',
    'export function CountUp({ duration = 2 }) {',
    '  useEffect(() => undefined, [])',
    '  const value = useCountUp(duration)',
    '  return <span>{value}</span>',
    '}',
    '',
  ].join('\n'),
  SplitText: "import { gsap } from 'gsap'\n\nexport function SplitText() { return null }\n",
  GhostText: "import { motion } from 'motion/react'\n\nexport function GhostText() { return <motion.span animate={{ opacity: 1 }} /> }\n",
}

/** A fetch that answers from the fixture. */
const serve: ReactBitsFetcher = async (url) => {
  if (url === REACTBITS_INDEX_URL) return JSON.stringify(INDEX)
  const name = url.slice(reactbitsItemUrl('').length)
  const entry = (INDEX.items as readonly Record<string, unknown>[]).find(item => item.name === name)
  if (entry === undefined) return '<!doctype html><html></html>'
  const title = entry.title as string
  return JSON.stringify({
    ...entry,
    files: (entry.files as readonly { readonly path: string }[]).map(file => (file.path.endsWith('.css')
      // A sheet that animates and ignores the system setting, which is what upstream's
      // CSS variants look like: the write path has a real reduced-motion case to bound.
      ? { ...file, type: 'registry:style', content: '.split { opacity: 0; animation: rise 600ms ease-out forwards }\n' }
      : { ...file, content: SOURCE[title] ?? '' })),
  })
}

/**
 * The call members, which the definition shape deliberately leaves to each module.
 *
 * `ToolDefinitionShape` checks what the model sees — name, description, parameters,
 * output — and says nothing about `execute`/`presentCall`, because every module in
 * this package types its own arguments narrowly. A spec that wants to *call* the
 * tool therefore states that face here rather than reaching through `unknown`.
 */
interface CallableTool {
  readonly name: string
  readonly description: string
  readonly parameters: { readonly properties: Record<string, { readonly enum?: readonly string[]; readonly maximum?: number }> }
  execute(args: unknown, exec?: unknown): Promise<unknown>
  presentCall(args: unknown): { readonly title: string }
}

/**
 * A file service over an in-memory tree.
 *
 * The write path only needs three members, so the fixture is one object with a map
 * behind it: `readText` answers for what is there and throws for what is not, which
 * is the same condition the real service reports — and the same one `if_exists`
 * decides on.
 */
function fakeFiles(initial: Readonly<Record<string, string>> = {}): {
  readonly service: ReactBitsFileService
  readonly files: ReadonlyMap<string, string>
  readonly intents: readonly unknown[]
  readonly writes: readonly string[]
} {
  const files = new Map<string, string>(Object.entries(initial))
  const intents: unknown[] = []
  const writes: string[] = []
  return {
    service: {
      resolve: async (path: string) => path,
      readText: async (target: unknown) => {
        const text = files.get(String(target))
        if (text === undefined) throw new Error(`ENOENT: ${String(target)}`)
        return text
      },
      writeText: async (target: unknown, content: string, intent?: unknown) => {
        intents.push(intent)
        writes.push(String(target))
        const existed = files.has(String(target))
        files.set(String(target), content)
        return { operation: existed ? 'update' : 'create', version: 1 }
      },
    },
    files,
    intents,
    writes,
  }
}

/** The tool, with a fixture catalogue instead of the network. */
function tool(fetch: ReactBitsFetcher = serve, host?: { get(name: string): unknown }): CallableTool {
  const catalogue = new ReactBitsCatalogue(fetch, () => Date.parse('2026-09-27T00:00:00.000Z'))
  return reactbitsToolDefinition(host, catalogue) as unknown as CallableTool
}

/** Run the tool and hand back the answer, whatever shape it is. */
async function run(args: unknown, exec?: unknown): Promise<Record<string, unknown>> {
  return await tool().execute(args, exec) as Record<string, unknown>
}

/** The session a write resolves its destination against. */
const WORKSPACE = { agent: { session: { header: { cwd: 'C:/work/app' } } } }

describe('the definition', () => {
  it('is the name the design row lists, with the two actions and their bounds', () => {
    const definition = tool()
    expect(definition.name).toBe(REACTBITS_TOOL_NAME)
    expect(definition.name).toBe('freecodego_reactbits')
    const properties = definition.parameters.properties
    expect(properties.action?.enum).toEqual(['search', 'get', 'apply'])
    expect(properties.language?.enum).toEqual(['js', 'ts'])
    expect(properties.style?.enum).toEqual(['css', 'tailwind'])
    expect(properties.limit?.maximum).toBe(20)
  })

  it('says what it does, what it writes, and what it never installs', () => {
    const description = tool().description
    expect(description).toContain('https://reactbits.dev')
    expect(description).toContain('Nothing is ever installed')
    expect(description).toContain('prefers-reduced-motion')
    expect(description).toContain('no component is cached or kept by this package')
  })

  it('needs no context, which is what makes it work on a bare installation', async () => {
    // Called with one argument and no execution context at all: a tool that reached
    // for a file service or a browser would throw here, and the design row's own
    // promise is that this one needs neither.
    const answer = await run({ action: 'search', query: 'count' })
    expect(answer.kind).toBe('catalogue')
  })

  it('titles a call by the action it is making', () => {
    // Read off the definition and called as a method rather than extracted into a
    // variable: the two titles are one statement about how a call is labelled, and a
    // detached reference would be linted as an unbound method (it is one).
    const definition = tool()
    expect(definition.presentCall({ action: 'search', query: 'split' }).title).toBe('React Bits search: split')
    expect(definition.presentCall({ action: 'get', component: 'CountUp' }).title).toBe('React Bits component: CountUp')
  })
})

describe('search', () => {
  it('returns index rows with no source in them, and says so', async () => {
    const answer = await run({ action: 'search', query: 'count' })
    expect(answer.kind).toBe('catalogue')
    expect(answer.matched).toBe(1)
    // Four rows, three components: the index is variant-first, and the two counts
    // are reported separately because a caller deciding whether the catalogue is
    // being read at all needs the row count rather than the folded one.
    expect(answer.catalogue).toMatchObject({
      url: 'https://reactbits.dev/r/registry.json',
      components: 3,
      entries: 4,
    })
    const hits = answer.hits as readonly Record<string, unknown>[]
    expect(hits[0]).toMatchObject({ component: 'CountUp', slug: 'count-up', variants: ['CountUp-TS-TW', 'CountUp-TS-CSS'] })
    // No `content` field anywhere in a search result: the index has none, and a
    // search that returned source would be fetching four components to answer one
    // question.
    expect(JSON.stringify(answer)).not.toContain('export function')
    expect((answer.notes as readonly string[]).join(' ')).toContain('no source')
  })

  it('keeps only what needs no package when asked, and says the filter ran', async () => {
    const answer = await run({ action: 'search', query: 'fixture', dependency_free: true })
    const hits = answer.hits as readonly Record<string, unknown>[]
    expect(hits.map(hit => hit.component)).toEqual(['CountUp'])
    expect((answer.notes as readonly string[]).join(' ')).toContain('no package beyond React')
  })

  it('reports a keyword that matched nothing as a search that ran', async () => {
    const answer = await run({ action: 'search', query: 'nothing here' })
    expect(answer.matched).toBe(0)
    expect(answer.hits).toEqual([])
    expect((answer.notes as readonly string[]).join(' ')).toContain('none matched')
  })
})

describe('get', () => {
  it('returns one variant\\u2019s source, its files as they should be written, and the review', async () => {
    const answer = await run({ action: 'get', component: 'SplitText', language: 'ts', style: 'css' })
    expect(answer.kind).toBe('component')
    expect(answer.component).toBe('SplitText')
    expect(answer.variant).toMatchObject({ name: 'SplitText-TS-CSS', language: 'ts', style: 'css', alternatives: [] })
    const files = answer.files as readonly Record<string, unknown>[]
    expect(files.map(file => [file.path, file.writeAs, file.role, file.delivered])).toEqual([
      ['SplitText/SplitText.tsx', 'SplitText.tsx', 'component', true],
      ['SplitText/SplitText.css', 'SplitText.css', 'style', true],
    ])
    expect(files[0]?.content).toContain('export function SplitText')
    expect(answer.dependencies).toEqual(['gsap@^3.13.0'])
    // The review travels with the source, and it flagged the directive as the thing
    // that decides whether this file can be used at all.
    const inspection = answer.inspection as { readonly ready: boolean; readonly findings: readonly { readonly id: string }[] }
    expect(inspection.ready).toBe(false)
    expect(inspection.findings.map(entry => entry.id)).toContain('client-directive')
  })

  it('defaults to the TypeScript Tailwind variant and lists the others', async () => {
    const answer = await run({ action: 'get', component: 'count-up' })
    expect(answer.variant).toMatchObject({ name: 'CountUp-TS-TW', language: 'ts', style: 'tailwind', alternatives: ['CountUp-TS-CSS'] })
  })

  it('carries the licence\\u2019s two sentences, because the next conversation needs them', async () => {
    const answer = await run({ action: 'get', component: 'CountUp' })
    const license = answer.license as { readonly name: string; readonly permits: string; readonly forbids: string; readonly note: string }
    expect(license.name).toBe('MIT + Commons Clause')
    expect(license.permits).toContain('使用')
    expect(license.forbids).toContain('再分发')
    expect(license.note).toContain('本包不内置')
    expect(String(answer.next)).toContain('redistribution is not')
  })

  it('names the packages instead of installing them, and says the source is not written', async () => {
    const answer = await run({ action: 'get', component: 'GhostText' })
    const notes = (answer.notes as readonly string[]).join('\n')
    expect(notes).toContain('motion@^12.23.12')
    expect(notes).toContain('own package manager')
    expect(notes).toContain('place each file with your own editing tools')
    expect(notes).toContain('action "apply"')
  })

  it('checks the props the caller asked about, so a component that lacks one says so', async () => {
    const answer = await run({ action: 'get', component: 'CountUp', props: ['duration', 'onComplete'] })
    const checks = answer.propChecks as readonly { readonly prop: string; readonly present: boolean; readonly evidence?: string }[]
    expect(checks.map(check => [check.prop, check.present])).toEqual([['duration', true], ['onComplete', false]])
    // Cited, not merely asserted: the caller has to be able to see where the prop
    // was found, or "present" is a claim about a file they cannot check.
    expect(checks[0]?.evidence).toContain('duration')
    expect((answer.notes as readonly string[]).join(' ')).toContain('These props were not found in the source: onComplete')
  })

  it('reports a local import the caller has to place as well', async () => {
    const answer = await run({ action: 'get', component: 'CountUp' })
    const inspection = answer.inspection as { readonly localImports: readonly string[] }
    expect(inspection.localImports).toEqual(['./useCountUp'])
  })
})

/** A file a caller already has, to be left alone unless they say otherwise. */
const MINE = '// mine\n'

describe('apply: placing the component in the project', () => {
  /** The tool plus an in-memory file service, as the host would hand both over. */
  function world(initial: Readonly<Record<string, string>> = {}) {
    const files = fakeFiles(initial)
    return { files, definition: tool(serve, { get: (name: string) => (name === 'fs' ? files.service : undefined) }) }
  }

  it('writes the files into the destination the caller named, and reports each one', async () => {
    const { definition } = world()
    const answer = await definition.execute(
      { action: 'apply', component: 'SplitText', language: 'ts', style: 'css', directory: 'src/components/reactbits', confirm: true, target: 'next' },
      WORKSPACE,
    ) as {
      readonly kind: string
      readonly written: readonly {
        readonly path: string
        readonly operation: string
        readonly transformations: readonly { readonly id: string }[]
      }[]
      readonly directory: string
      readonly resolvedDirectory: string
      readonly followUps: readonly { readonly id: string }[]
      readonly license: { readonly forbids: string }
    }
    expect(answer.kind).toBe('applied')
    expect(answer.directory).toBe('src/components/reactbits')
    expect(answer.resolvedDirectory).toBe('C:/work/app/src/components/reactbits')
    expect(answer.written.map(entry => entry.path)).toEqual([
      'C:/work/app/src/components/reactbits/SplitText.tsx',
      'C:/work/app/src/components/reactbits/SplitText.css',
    ])
    expect(answer.written.every(entry => entry.operation === 'create')).toBe(true)
    // The two alterations, each named per file: the directive on the component, the
    // bounded-motion block on the sheet that animates.
    expect(answer.written[0]?.transformations.map(change => change.id)).toEqual(['client-directive'])
    expect(answer.written[1]?.transformations.map(change => change.id)).toEqual(['reduced-motion'])
    expect(answer.followUps.map(follow => follow.id)).toEqual(['client-directive', 'reduced-motion-bounded'])
    // And the licence travelled with the write, because what was written is exactly
    // the thing the licence governs.
    expect(answer.license.forbids).toContain('再分发')
  })

  it('adds the directive exactly where the review called it blocking', async () => {
    const next = world()
    await next.definition.execute({ action: 'apply', component: 'CountUp', directory: 'ui', confirm: true, target: 'next' }, WORKSPACE)
    expect(next.files.files.get('C:/work/app/ui/CountUp.tsx')?.startsWith("'use client'")).toBe(true)

    const vite = world()
    await vite.definition.execute({ action: 'apply', component: 'CountUp', directory: 'ui', confirm: true, target: 'vite' }, WORKSPACE)
    expect(vite.files.files.get('C:/work/app/ui/CountUp.tsx')?.startsWith("'use client'")).toBe(false)

    const never = world()
    await never.definition.execute({ action: 'apply', component: 'CountUp', directory: 'ui', confirm: true, target: 'next', client_directive: 'never' }, WORKSPACE)
    expect(never.files.files.get('C:/work/app/ui/CountUp.tsx')?.startsWith("'use client'")).toBe(false)
  })

  it('refuses without a confirmation, and names every path it would have written', async () => {
    const { files, definition } = world()
    const answer = await definition.execute(
      { action: 'apply', component: 'SplitText', style: 'css', directory: 'src/bits' },
      WORKSPACE,
    ) as { readonly reason: string; readonly message: string; readonly wouldWrite: readonly string[] }
    expect(answer.reason).toBe('confirmation-required')
    expect(answer.wouldWrite).toEqual(['C:/work/app/src/bits/SplitText.tsx', 'C:/work/app/src/bits/SplitText.css'])
    expect(answer.message).toContain('confirm: true')
    // Nothing was written before the decision was made, which is the whole point of
    // asking: the plan is computed from the fetched item and then reported, not acted on.
    expect(files.writes).toEqual([])
  })

  it('leaves an existing file alone by default, and replaces it only when told to', async () => {
    const existing = { 'C:/work/app/ui/CountUp.tsx': MINE }
    const keep = world(existing)
    const kept = await keep.definition.execute({ action: 'apply', component: 'CountUp', directory: 'ui', confirm: true }, WORKSPACE) as {
      readonly skipped: readonly { readonly path: string; readonly reason: string }[]
      readonly written: readonly { readonly path: string }[]
      readonly notes: readonly string[]
    }
    // The item's other file is not there, so it is written while the file that is
    // there is left alone: the policy is per file, not per call.
    expect(kept.written.map(entry => entry.path)).toEqual(['C:/work/app/ui/useCountUp.ts'])
    expect(kept.skipped[0]?.path).toBe('C:/work/app/ui/CountUp.tsx')
    expect(kept.skipped[0]?.reason).toContain('if_exists is "skip"')
    expect(keep.files.files.get('C:/work/app/ui/CountUp.tsx')).toBe(MINE)

    const replace = world(existing)
    const replaced = await replace.definition.execute({ action: 'apply', component: 'CountUp', directory: 'ui', confirm: true, if_exists: 'replace' }, WORKSPACE) as {
      readonly written: readonly { readonly operation: string }[]
    }
    expect(replaced.written[0]?.operation).toBe('update')
    expect(replace.files.files.get('C:/work/app/ui/CountUp.tsx')).toContain('export function CountUp')
  })

  it('refuses a destination that leaves the working directory, before writing anything', async () => {
    for (const directory of ['../outside', 'C:/elsewhere', '/srv/app', 'src/../../etc']) {
      const { files, definition } = world()
      const answer = await definition.execute({ action: 'apply', component: 'CountUp', directory, confirm: true }, WORKSPACE) as { readonly reason: string }
      expect(answer.reason, directory).toBe('invalid-directory')
      expect(files.writes, directory).toEqual([])
    }
  })

  it('refuses when the session has no working directory to resolve against', async () => {
    const { definition } = world()
    const answer = await definition.execute({ action: 'apply', component: 'CountUp', directory: 'ui', confirm: true }) as { readonly reason: string }
    expect(answer.reason).toBe('unknown-workspace')
  })

  it('tells a read-only installation from one with no file service at all', async () => {
    const readOnly = tool(serve, { get: () => ({ resolve: async () => undefined, readText: async () => '' }) })
    expect((await readOnly.execute({ action: 'apply', component: 'CountUp', directory: 'ui', confirm: true }, WORKSPACE) as { readonly reason: string }).reason).toBe('no-write-service')
    const none = tool(serve, { get: () => undefined })
    expect((await none.execute({ action: 'apply', component: 'CountUp', directory: 'ui', confirm: true }, WORKSPACE) as { readonly reason: string }).reason).toBe('no-file-service')
  })

  it('offers the host the write decision before each write, and passes it through', async () => {
    const files = fakeFiles()
    const asked: unknown[] = []
    const host = {
      get: (name: string) => (name === 'fs' ? files.service : undefined),
      waterfall: async (event: string, ...args: readonly unknown[]) => {
        asked.push([event, ...args.slice(0, 1)])
        return { kind: 'createIfAbsent' }
      },
    }
    await tool(serve, host).execute({ action: 'apply', component: 'CountUp', directory: 'ui', confirm: true }, WORKSPACE)
    // The host is asked once per file, and what it answers reaches the write itself:
    // a policy that says create-if-absent is the host refusing an overwrite, not this
    // tool deciding one.
    expect(asked.map(entry => (entry as readonly unknown[])[0])).toEqual(['fs/write-intent', 'fs/write-intent'])
    expect(files.intents).toEqual([{ kind: 'createIfAbsent' }, { kind: 'createIfAbsent' }])
  })

  it('reports a file the host refused as a failure on that file, and keeps writing the others', async () => {
    const files = fakeFiles()
    // Wrapped rather than referenced: a detached method would lose the fixture's own
    // `this`, and the wrapping is what keeps this a *different* service from the one
    // the fixture reports — a host whose write fails on one file.
    const service: ReactBitsFileService = {
      resolve: async (path: string) => files.service.resolve(path),
      readText: async (target: unknown) => files.service.readText(target),
      writeText: async (target, content, intent, signal) => {
        if (String(target).endsWith('.css')) throw new Error('FS_NOT_OBSERVED: guarded write refused')
        return await files.service.writeText?.(target, content, intent, signal)
      },
    }
    const definition = tool(serve, { get: (name: string) => (name === 'fs' ? service : undefined) })
    const answer = await definition.execute({ action: 'apply', component: 'SplitText', style: 'css', directory: 'ui', confirm: true }, WORKSPACE) as {
      readonly written: readonly unknown[]
      readonly failed: readonly { readonly path: string; readonly reason: string }[]
      readonly notes: readonly string[]
    }
    expect(answer.written).toHaveLength(1)
    expect(answer.failed[0]?.path).toBe('C:/work/app/ui/SplitText.css')
    expect(answer.failed[0]?.reason).toContain('guarded write refused')
    // The reason names the host's policy, because that refusal is not this tool's to
    // override and a caller who does not know where it came from will keep retrying.
    expect(answer.notes.join(' ')).toContain('own write policy')
  })

  it('refuses the arguments it cannot act on', async () => {
    const cases: readonly { readonly args: unknown; readonly reason: string }[] = [
      { args: { action: 'apply', component: 'CountUp', confirm: true }, reason: 'missing-directory' },
      { args: { action: 'apply', component: 'CountUp', directory: '  ', confirm: true }, reason: 'missing-directory' },
      { args: { action: 'apply', component: 'CountUp', directory: 'x'.repeat(301), confirm: true }, reason: 'directory-too-long' },
      { args: { action: 'apply', component: 'CountUp', directory: 'ui', confirm: true, if_exists: 'merge' }, reason: 'invalid-if-exists' },
      { args: { action: 'apply', component: 'CountUp', directory: 'ui', confirm: true, client_directive: 'maybe' }, reason: 'invalid-client-directive' },
      { args: { action: 'apply', component: 'CountUp', directory: 'ui', confirm: true, reduced_motion: 'yes' }, reason: 'invalid-reduced-motion' },
      { args: { action: 'apply', directory: 'ui', confirm: true }, reason: 'missing-component' },
      { args: { action: 'apply', component: 'CountUp', directory: 'ui', confirm: true, language: 'python' }, reason: 'invalid-language' },
    ]
    for (const testCase of cases) {
      const answer = await run(testCase.args, WORKSPACE)
      expect(answer.kind, JSON.stringify(testCase.args)).toBe('refused')
      expect(answer.reason, JSON.stringify(testCase.args)).toBe(testCase.reason)
    }
  })

  it('titles an apply by its destination, so the card says where the files are going', () => {
    const definition = tool()
    expect(definition.presentCall({ action: 'apply', component: 'CountUp', directory: 'src/bits' }).title)
      .toBe('React Bits apply: CountUp → src/bits')
  })
})

describe('names that name nothing', () => {
  it('refuses an unknown component and says where to look instead', async () => {
    const answer = await run({ action: 'get', component: 'NoSuchThing' })
    expect(answer.kind).toBe('refused')
    expect(answer.reason).toBe('unknown-component')
    expect(String(answer.message)).toContain('Search first')
  })

  it('refuses an ambiguous keyword, offering the components it matched', async () => {
    const answer = await run({ action: 'get', component: 'text' })
    expect(answer.reason).toBe('ambiguous-component')
    expect(answer.available).toEqual(['GhostText', 'SplitText'])
  })

  it('resolves a keyword that only one component contains, and says it was a partial match', async () => {
    const answer = await run({ action: 'get', component: 'ghost' })
    expect(answer.component).toBe('GhostText')
    expect((answer.notes as readonly string[]).join(' ')).toContain('only component containing it')
  })

  it('refuses a variant the component does not publish, listing the ones it does', async () => {
    const answer = await run({ action: 'get', component: 'CountUp', style: 'css', language: 'js' })
    expect(answer.reason).toBe('unknown-variant')
    expect(answer.available).toEqual(['CountUp-TS-CSS', 'CountUp-TS-TW'])
  })
})

describe('a machine with no network, and every other refusal', () => {
  it('reports an unreachable registry as a reason rather than as an empty catalogue', async () => {
    const offline = tool(async () => { throw new Error('getaddrinfo ENOTFOUND reactbits.dev') })
    const answer = await offline.execute({ action: 'search', query: 'count' }) as Record<string, unknown>
    expect(answer.kind).toBe('refused')
    expect(answer.reason).toBe('catalogue-unavailable')
    expect(String(answer.message)).toContain('needs the network')
    expect(String(answer.message)).toContain('ENOTFOUND')
  })

  it('tells an unreadable document from an unreachable one', async () => {
    const odd = tool(async () => JSON.stringify({ name: '@react-bits' }))
    const answer = await odd.execute({ action: 'search', query: 'count' }) as Record<string, unknown>
    expect(answer.reason).toBe('unexpected-document')
  })

  it('refuses the arguments it cannot act on', async () => {
    const cases: readonly { readonly args: unknown; readonly reason: string }[] = [
      { args: undefined, reason: 'invalid-arguments' },
      { args: { action: 'download' }, reason: 'invalid-action' },
      { args: { action: 'search', query: '   ' }, reason: 'empty-query' },
      { args: { action: 'search', query: 'x'.repeat(201) }, reason: 'query-too-long' },
      { args: { action: 'search', query: 'x', limit: 0 }, reason: 'invalid-limit' },
      { args: { action: 'search', query: 'x', limit: 2.5 }, reason: 'invalid-limit' },
      { args: { action: 'search', query: 'x', dependency_free: 'yes' }, reason: 'invalid-dependency-free' },
      { args: { action: 'get' }, reason: 'missing-component' },
      { args: { action: 'get', component: 'x'.repeat(121) }, reason: 'component-too-long' },
      { args: { action: 'get', component: 'CountUp', language: 'python' }, reason: 'invalid-language' },
      { args: { action: 'get', component: 'CountUp', style: 'sass' }, reason: 'invalid-style' },
      { args: { action: 'get', component: 'CountUp', props: 'duration' }, reason: 'invalid-props' },
    ]
    for (const testCase of cases) {
      const answer = await run(testCase.args)
      expect(answer.kind, JSON.stringify(testCase.args)).toBe('refused')
      expect(answer.reason, JSON.stringify(testCase.args)).toBe(testCase.reason)
    }
  })
})
