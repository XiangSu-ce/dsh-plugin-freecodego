/**
 * The model-facing Impeccable detector.
 *
 * The definition rather than a registration: the design page's switch registers
 * this tool now (`design/features.ts` lists it, `design/tools.ts` supplies it,
 * and `design-tools.spec` holds that pair together). What is left to check here
 * is the tool itself, and the two properties that decide whether it is honest:
 *
 *  - **Which backend answered, and that the answer says so.** Every result names
 *    the backend, the rules that ran, and upstream's total, so "no findings" from
 *    a twelve-rule subset cannot be read as "nothing to report" from sixty-one.
 *  - **What it refuses, and why.** A URL with no engine, a missing file service,
 *    an unreadable target, and eight kinds of malformed argument all come back as
 *    a refusal naming the reason, because a scan that silently read nothing is
 *    indistinguishable from a clean one.
 *
 * The environment is stubbed rather than assumed: the engine probes are the one
 * thing here that reads the machine, and a developer who has an engine installed
 * must still get the built-in behaviour this file is pinning.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/impeccable-tool
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { IMPECCABLE_ENGINE_ENV } from '../src/impeccable/engine.ts'
import {
  IMPECCABLE_DETECT_TOOL_NAME,
  impeccableDetectToolDefinition,
} from '../src/impeccable/tool.ts'

/** One entry of a fake directory listing. */
interface FakeEntry {
  readonly name: string
  readonly type: 'file' | 'directory' | 'other'
  readonly target: unknown
}

/**
 * The `fs` service as this tool uses it, over a path-keyed map of files.
 *
 * `listDir` is optional in the service and in this fake, because a composition
 * that provides only `resolve`/`readText` is a real installation shape: the
 * directory case is skipped there and the tool has to say so rather than pretend
 * the directory was empty.
 */
interface FakeFileService {
  readonly resolve: (path: string) => Promise<{ readonly path: string }>
  readonly readText: (target: unknown) => Promise<string>
  readonly listDir?: (target: unknown) => Promise<readonly FakeEntry[]>
}

/** The path a resolved target carries, or an empty string. */
function pathOf(target: unknown): string {
  const path = (target as { readonly path?: unknown }).path
  return typeof path === 'string' ? path : ''
}

function fileService(files: Readonly<Record<string, string>>, options: { readonly list?: boolean } = {}): {
  readonly service: FakeFileService
  readonly reads: string[]
} {
  const reads: string[] = []
  const service: FakeFileService = {
    resolve: async (path: string) => ({ path }),
    readText: async (target: unknown) => {
      const path = pathOf(target)
      reads.push(path)
      const text = files[path]
      if (text === undefined) throw new Error(`no such file: ${path}`)
      return text
    },
    // Present only when the case asks for it, because a service without `listDir`
    // is a real installation shape and refusing a directory is the behaviour one of
    // the cases below is about.
    ...(options.list === true ? { listDir: async (target: unknown) => listings[pathOf(target)] ?? [] } : {}),
  }
  return { service, reads }
}

/** Directory listings, keyed by the directory path the tool resolved. */
let listings: Record<string, readonly FakeEntry[]> = {}

/** The definition's shape as far as a caller of `execute` needs it. */
interface DetectTool {
  readonly name: string
  readonly description: string
  readonly parameters: {
    readonly required?: readonly string[]
    readonly properties?: Readonly<Record<string, { readonly maxLength?: number; readonly enum?: readonly string[] }>>
  }
  readonly execute: (args: unknown, exec?: unknown) => Promise<Record<string, unknown>>
  readonly presentCall: (args: unknown) => { readonly title: string }
}

const roots: string[] = []
afterEach(() => {
  listings = {}
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A temporary directory, removed after the case. */
function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'freecodego-impeccable-'))
  roots.push(root)
  return root
}

/**
 * Run as if this machine had no engine at all.
 *
 * The probes read `process.env`, so the three inputs are stubbed rather than
 * argued about: an unset `IMPECCABLE_ENGINE`, an empty `$PATH`, and a home
 * directory with nothing in it.
 */
function withoutEngine(): void {
  vi.stubEnv(IMPECCABLE_ENGINE_ENV, '')
  vi.stubEnv('PATH', '')
  vi.stubEnv('Path', '')
  vi.stubEnv('HOME', temporary())
  vi.stubEnv('USERPROFILE', process.env.HOME ?? '')
}

/** The tool over one fake context. */
function harness(ctx: unknown): DetectTool {
  return impeccableDetectToolDefinition(ctx as never) as unknown as DetectTool
}

/** Assertions read through one accessor, so a field rename lands in one place. */
const findings = (result: Record<string, unknown>): readonly Record<string, unknown>[] =>
  result.findings as readonly Record<string, unknown>[]
const notes = (result: Record<string, unknown>): readonly string[] => result.notes as readonly string[]
const counts = (result: Record<string, unknown>): Record<string, number> => result.counts as Record<string, number>
const scanned = (result: Record<string, unknown>): Record<string, unknown> => result.scanned as Record<string, unknown>

/**
 * A CSS file with two `slop` findings and one `quality` finding beside them.
 *
 * Deliberately the shape real code has: the clip is written with its vendor
 * prefix, which is the only spelling that actually clips text, so a scanner that
 * needed the unprefixed name would report this file as clean.
 */
const SLOP_AND_QUALITY = [
  'body { font-family: Inter, sans-serif; }',
  '.title { background: linear-gradient(90deg, #a855f7, #ec4899); -webkit-background-clip: text; color: transparent; }',
  '.tiny { font-size: 9px; }',
].join('\n')

describe('the detector definition', () => {
  it('takes one required path, and says what it does not do', () => {
    const tool = harness({ get: () => undefined })
    expect(tool.name).toBe(IMPECCABLE_DETECT_TOOL_NAME)
    expect(tool.parameters.required).toEqual(['path'])
    expect(tool.parameters.properties?.path?.maxLength).toBe(1_024)
    expect(tool.parameters.properties?.category?.enum).toEqual(['slop', 'quality'])
    expect(tool.description).toContain('never writes, downloads, or installs anything')
    // The bound is in the schema description, not only in the result: a caller
    // reading the tool list learns it before paying for a call that refuses.
    expect(String(tool.parameters.properties?.backend?.enum)).toContain('builtin')
  })

  it('names the path in the call card, bounded', () => {
    const tool = harness({ get: () => undefined })
    expect(tool.presentCall({ path: 'src/page.tsx' }).title).toBe('Impeccable detect: src/page.tsx')
    expect(tool.presentCall({ path: 'x'.repeat(400) }).title.length).toBeLessThan(120)
  })
})

describe('the built-in backend', () => {
  it('scans one file and says which backend answered', async () => {
    withoutEngine()
    const { service } = fileService({ '/work/page.css': SLOP_AND_QUALITY })
    const tool = harness({ get: (name: string) => name === 'fs' ? service : undefined })

    const result = await tool.execute({ path: '/work/page.css' })
    expect(result.kind).toBe('scanned')
    expect(result.backend).toBe('builtin')
    // The two halves of the answer a caller has to be able to tell apart.
    expect(result.coverage).toMatchObject({ backend: 'builtin', of: 61 })
    expect(notes(result).some(note => note.includes('No Impeccable engine was found'))).toBe(true)
    // Line order, then rule name — one file, four findings, in the order a reader
    // scrolling the file meets them. The clipped headline is one declaration group
    // and produces both of its rules, which is why the gradient's palette is here.
    expect(findings(result).map(finding => finding.rule)).toEqual([
      'overused-font', 'ai-color-palette', 'gradient-text', 'tiny-text',
    ])
    expect(result.counts).toMatchObject({ findings: 4, primary: 4, advisory: 0 })
    expect(scanned(result)).toMatchObject({ files: 1 })
    // Every finding names the file it came from, which is what makes a
    // multi-file answer usable.
    expect(findings(result).every(finding => finding.file === '/work/page.css')).toBe(true)
  })

  it('withholds advisories unless they were asked for, and says that it did', async () => {
    // Upstream keeps advisories out of its exit code, and a caller that did not
    // ask for them gets the same view — but a count that silently dropped them
    // would read as a clean file.
    withoutEngine()
    const source = '<p>We streamline your workflow for teams.</p>'
    const { service } = fileService({ '/work/page.html': source })
    const tool = harness({ get: (name: string) => name === 'fs' ? service : undefined })

    const quiet = await tool.execute({ path: '/work/page.html' })
    expect(findings(quiet)).toHaveLength(0)
    expect(notes(quiet).some(note => note.includes('advisory finding(s) were withheld'))).toBe(true)

    const loud = await tool.execute({ path: '/work/page.html', include_advisories: true })
    expect(findings(loud).map(finding => finding.rule)).toContain('marketing-buzzword')
    expect(counts(loud).advisory).toBe(1)
    expect(notes(loud).some(note => note.includes('withheld'))).toBe(false)
  })

  it('filters by category without pretending the other half was checked', async () => {
    withoutEngine()
    const { service } = fileService({ '/work/page.css': SLOP_AND_QUALITY })
    const tool = harness({ get: (name: string) => name === 'fs' ? service : undefined })

    const slop = await tool.execute({ path: '/work/page.css', category: 'slop' })
    expect(findings(slop).map(finding => finding.rule)).not.toContain('tiny-text')
    expect(counts(slop).byCategory).toMatchObject({ slop: 3 })

    const quality = await tool.execute({ path: '/work/page.css', category: 'quality' })
    expect(findings(quality).map(finding => finding.rule)).toEqual(['tiny-text'])
    // The rules that ran are still reported, so a filtered scan does not look like
    // a scan by a smaller rule set.
    expect((quality.coverage as Record<string, unknown>).rules).toBeGreaterThan(1)
  })

  it('walks a directory, skips what it cannot read, and names every skip', async () => {
    // A scan that quietly read three of forty files reads exactly like a clean
    // directory, and the difference matters most when the news is good.
    withoutEngine()
    const source = '.card { font-family: Geist, sans-serif; }'
    const { service } = fileService(
      { '/work/src/card.css': source, '/work/src/page.jsx': 'export const Page = () => <p>Ready.</p>\n' },
      { list: true },
    )
    listings = {
      '/work': [
        { name: 'src', type: 'directory', target: { path: '/work/src' } },
        { name: 'logo.png', type: 'file', target: { path: '/work/logo.png' } },
        { name: 'notes.txt', type: 'file', target: { path: '/work/notes.txt' } },
        { name: 'pipe', type: 'other', target: { path: '/work/pipe' } },
      ],
      '/work/src': [
        { name: 'card.css', type: 'file', target: { path: '/work/src/card.css' } },
        { name: 'page.jsx', type: 'file', target: { path: '/work/src/page.jsx' } },
        { name: 'nested', type: 'directory', target: { path: '/work/src/nested' } },
      ],
      '/work/src/nested': [],
    }
    const tool = harness({ get: (name: string) => name === 'fs' ? service : undefined })

    const result = await tool.execute({ path: '/work' })
    expect(result.kind).toBe('scanned')
    // The finding came from the file the walk had to descend for, so a walk that
    // listed the root and stopped cannot pass this.
    expect(findings(result).map(finding => finding.rule)).toEqual(['overused-font'])
    expect(findings(result)[0]?.file).toBe('/work/src/card.css')
    const skips = scanned(result).skipped as readonly { readonly path: string; readonly reason: string }[]
    expect(skips.map(skip => skip.path)).toEqual(['/work/logo.png', '/work/notes.txt', '/work/pipe'])
    expect(skips.map(skip => skip.reason)).toEqual([
      'extension .png is not a UI source file',
      'extension .txt is not a UI source file',
      'not a regular file',
    ])
  })

  it('stops at max_files and at the depth bound, reporting the bound itself', async () => {
    withoutEngine()
    const build = (depth: number): string => depth === 0 ? '/work/root' : `${build(depth - 1)}/d${String(depth)}`
    // Five levels of directories, each holding four readable files, so both bounds
    // bite — and the read failures of an earlier revision of this fixture cannot
    // be mistaken for the bound itself.
    const files: Record<string, string> = {}
    const { service } = fileService(files, { list: true })
    for (let depth = 0; depth <= 5; depth += 1) {
      const directory = build(depth)
      listings[directory] = [
        ...Array.from({ length: 4 }, (_value, index) => {
          const path = `${directory}/f${String(index)}.css`
          files[path] = '.card { font-size: 20px; }'
          return { name: `f${String(index)}.css`, type: 'file' as const, target: { path } }
        }),
        ...depth < 5 ? [{ name: `d${String(depth + 1)}`, type: 'directory' as const, target: { path: build(depth + 1) } }] : [],
      ]
    }
    const tool = harness({ get: (name: string) => name === 'fs' ? service : undefined })

    const limited = await tool.execute({ path: '/work/root', max_files: 3 })
    expect(scanned(limited).files).toBe(3)
    // The bound is the last thing said, and it is said: a caller who asked for 3
    // files learns that 3 is why the walk ended rather than inferring it from a
    // count that happens to look round.
    const bound = (scanned(limited).skipped as readonly { readonly reason: string }[]).at(-1)
    expect(bound?.reason).toBe('stopped after 3 files')

    // Depth: `oldest` (the limit) is reported rather than walked, and the reason
    // names the bound so a reader knows which one to raise.
    const deep = await tool.execute({ path: '/work/root', max_files: 200 })
    const reasons = (scanned(deep).skipped as readonly { readonly reason: string }[]).map(skip => skip.reason)
    expect(reasons).toContain('deeper than 4 directories')
  })

  it('refuses a directory when the file service cannot list one', async () => {
    // The distinction that matters: "not readable as a file" and "I cannot see
    // inside a directory" are different installations, and the second one needs a
    // different answer than "no findings".
    withoutEngine()
    const { service } = fileService({})
    const tool = harness({ get: (name: string) => name === 'fs' ? service : undefined })

    const result = await tool.execute({ path: '/work/src' })
    expect(result.kind).toBe('refused')
    expect(result.reason).toBe('unreadable-target')
    expect(String(result.message)).toContain('cannot list a directory')
  })
})

describe('the engine backend', () => {
  it('reports a shim it will not launch, then falls back for a file and refuses for a URL', async () => {
    // The env probe only accepts a path that exists, so the shim is a real file
    // on disk. It is never executed: the point of the case is that locating a
    // shell shim is not the same as having a usable engine, and a URL — the one
    // target only the engine can scan — is refused rather than silently downgraded
    // to a source scan.
    const root = temporary()
    const shim = join(root, 'impeccable.cmd')
    writeFileSync(shim, '@echo off\n')
    vi.stubEnv(IMPECCABLE_ENGINE_ENV, shim)

    const { service } = fileService({ '/work/page.css': SLOP_AND_QUALITY })
    const tool = harness({ get: (name: string) => name === 'fs' ? service : undefined })

    const file = await tool.execute({ path: '/work/page.css' })
    expect(file.kind).toBe('scanned')
    expect(file.backend).toBe('builtin')
    expect(notes(file).some(note => note.includes('shell shim'))).toBe(true)

    const url = await tool.execute({ path: 'https://example.test/pricing' })
    expect(url.kind).toBe('refused')
    expect(url.reason).toBe('engine-required-for-url')
    expect(String(url.message)).toContain('shell shim')
  })

  it('refuses a URL when no engine is installed at all, and names the ways out', async () => {
    withoutEngine()
    const tool = harness({ get: () => undefined })
    const result = await tool.execute({ path: 'https://example.test' })
    expect(result.kind).toBe('refused')
    expect(result.reason).toBe('engine-required-for-url')
    expect(String(result.message)).toContain(IMPECCABLE_ENGINE_ENV)
    expect(String(result.message)).toContain('name a source file for the built-in subset')
  })

  it('scans with the built-in subset when the caller forces it, engine or not', async () => {
    const root = temporary()
    const shim = join(root, 'impeccable.cmd')
    writeFileSync(shim, '@echo off\n')
    vi.stubEnv(IMPECCABLE_ENGINE_ENV, shim)
    const { service } = fileService({ '/work/page.css': SLOP_AND_QUALITY })
    const tool = harness({ get: (name: string) => name === 'fs' ? service : undefined })

    const result = await tool.execute({ path: '/work/page.css', backend: 'builtin' })
    // The engine was not consulted at all, so nothing about it is reported: the
    // note is about what happened, not about what exists.
    expect(result.backend).toBe('builtin')
    expect(notes(result)).toEqual([])
  })
})

describe('what the detector refuses', () => {
  const refusals: readonly { readonly args: unknown; readonly reason: string }[] = [
    { args: 'src/page.tsx', reason: 'invalid-arguments' },
    { args: {}, reason: 'invalid-path' },
    { args: { path: '   ' }, reason: 'invalid-path' },
    { args: { path: 'x'.repeat(1_025) }, reason: 'path-too-long' },
    { args: { path: 'a.html', category: 'taste' }, reason: 'invalid-category' },
    { args: { path: 'a.html', backend: 'engine' }, reason: 'invalid-backend' },
    { args: { path: 'a.html', max_files: 0 }, reason: 'invalid-max-files' },
    { args: { path: 'a.html', max_files: 2.5 }, reason: 'invalid-max-files' },
    { args: { path: 'a.html', max_files: 10_000 }, reason: 'invalid-max-files' },
    { args: { path: 'a.html', include_advisories: 'yes' }, reason: 'invalid-advisories' },
  ]

  it.each(refusals)('refuses $reason with the argument it cannot accept', async ({ args, reason }) => {
    withoutEngine()
    const tool = harness({ get: () => undefined })
    const result = await tool.execute(args)
    expect(result.kind).toBe('refused')
    expect(result.reason).toBe(reason)
    expect(String(result.message).length).toBeGreaterThan(10)
  })

  it('refuses when the installation has no file service, or cannot resolve the target', async () => {
    withoutEngine()
    const noService = await harness({ get: () => undefined }).execute({ path: 'src/page.tsx' })
    expect(noService.reason).toBe('no-file-service')

    const unresolved = await harness({
      get: (name: string) => name === 'fs'
        ? { resolve: async () => { throw new Error('outside the sandbox') } }
        : undefined,
    }).execute({ path: '../outside/page.tsx' })
    expect(unresolved.reason).toBe('unresolved-target')
    expect(String(unresolved.message)).toContain('../outside/page.tsx')
  })

  it('refuses a target the file service cannot read, rather than reporting no findings', async () => {
    withoutEngine()
    const { service } = fileService({})
    const tool = harness({ get: (name: string) => name === 'fs' ? service : undefined })
    const result = await tool.execute({ path: '/work/missing.css' })
    expect(result.kind).toBe('refused')
    expect(result.reason).toBe('unreadable-target')
  })
})

describe('the path the fake suite reads back', () => {
  it('resolves a relative target against the session working directory', async () => {
    // A design tool resolving against the plugin's own `process.cwd()` would scan
    // a different file than the model meant the moment a session opened a workspace.
    withoutEngine()
    const { service, reads } = fileService({ '/work/project/src/page.css': SLOP_AND_QUALITY })
    const tool = harness({ get: (name: string) => name === 'fs' ? service : undefined })

    await tool.execute({ path: 'src/page.css' }, { agent: { session: { header: { cwd: '/work/project' } } } })
    expect(reads).toEqual(['/work/project/src/page.css'])
  })
})
