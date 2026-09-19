/**
 * The code skeleton is the only Headroom strategy that deliberately touches an
 * *excluded* tool: `read` is protected byte-exact so Edit can match against the
 * original, and this feature is the one exception. That makes the safety
 * contract the whole test surface — a skeleton must be a subsequence of the
 * original numbered lines, never a rewrite, or Edit breaks silently.
 */

import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  CODE_SKELETON_DEFAULTS,
  READ_LIKE_TOOL_NAMES,
  isSkeletonEligibleTool,
  skeletonizeReadOutput,
} from '../src/headroom/code-skeleton.ts'
import { computeKey } from '../src/headroom/ccr.ts'
import { FreeCodeGoHeadroomRuntime, type HeadroomSettings } from '../src/headroom/runtime.ts'

/** Render a file the way the read tool does: envelope + `N: ` lines + footer. */
function readEnvelope(path: string, code: string, footer?: string): string {
  const lines = code.split('\n')
  const body = lines.map((line, index) => `${index + 1}: ${line}`).join('\n')
  const end = footer ?? `(End of file - total ${lines.length} lines)`
  return `<path>${path}</path>\n<type>file</type>\n<content>\n${body}\n\n${end}\n</content>`
}

/**
 * Real source files are mostly *statements inside bodies*. Padding a fixture
 * with top-level `const` declarations instead would be declarations — which the
 * skeleton rightly keeps — and would make the fixture unrepresentative.
 *
 * The count clears the 4 KB size floor comfortably: the skeleton is meant for
 * large reads, and a fixture below the floor would exercise the decline path
 * rather than the compression one.
 */
function paddingModule(count = 200): readonly string[] {
  return [
    '',
    'export function padding(): number {',
    '  let total = 0',
    ...Array.from({ length: count }, (_, index) => `  total += computeStep(${index})`),
    '  return total',
    '}',
  ]
}

/** A TypeScript module long enough to clear the size floor, with real bodies. */
function typescriptSource(): string {
  return [
    '/**',
    ' * Module doc comment that belongs to the first declaration.',
    ' */',
    "import { readFile } from 'node:fs/promises'",
    "import { join } from 'node:path'",
    '',
    'export interface LoadedFile {',
    '  readonly path: string',
    '  readonly bytes: number',
    '}',
    '',
    'export class FileLoader {',
    '  private readonly root: string',
    '  private cache = new Map<string, LoadedFile>()',
    '',
    '  constructor(root: string) {',
    '    this.root = root',
    '  }',
    '',
    '  async load(name: string): Promise<LoadedFile> {',
    '    const cached = this.cache.get(name)',
    '    if (cached !== undefined) return cached',
    '    const absolute = join(this.root, name)',
    '    const buffer = await readFile(absolute)',
    '    const loaded: LoadedFile = { path: absolute, bytes: buffer.byteLength }',
    '    this.cache.set(name, loaded)',
    '    return loaded',
    '  }',
    '',
    '  async loadMany(names: readonly string[]): Promise<readonly LoadedFile[]> {',
    '    const out: LoadedFile[] = []',
    '    for (const name of names) {',
    '      out.push(await this.load(name))',
    '    }',
    '    return out',
    '  }',
    '}',
    '',
    'export function describeFile(file: LoadedFile): string {',
    '  const { path, bytes } = file',
    '  const kilobytes = Math.round(bytes / 1024)',
    '  const parts = [path, `${kilobytes}KB`]',
    '  return parts.join(" ")',
    '}',
    ...paddingModule(),
  ].join('\n')
}

function proseDocument(): string {
  return Array.from({ length: 90 }, (_, index) => `Paragraph ${index}: ordinary prose that is not source code at all.`).join('\n')
}

describe('code skeleton — safety envelope', () => {
  it('declines anything smaller than the size floor and returns the input untouched', () => {
    const text = readEnvelope('src/tiny.ts', 'export const x = 1\nexport const y = 2')
    const result = skeletonizeReadOutput(text, computeKey(text))
    expect(result.applied).toBe(false)
    expect(result.output).toBe(text)
    expect(result.savings).toBe(0)
  })

  it('declines prose even when the file is large', () => {
    const text = readEnvelope('docs/guide.md', proseDocument())
    const result = skeletonizeReadOutput(text, computeKey(text))
    expect(result.applied).toBe(false)
    expect(result.output).toBe(text)
  })

  it('declines JSON, which already has a shape-routed compressor', () => {
    const records = Array.from({ length: 200 }, (_, index) => `  { "id": ${index}, "name": "record-${index}", "enabled": true },`).join('\n')
    const text = readEnvelope('data/records.json', `[\n${records}\n  { "id": 999, "name": "last", "enabled": false }\n]`)
    const result = skeletonizeReadOutput(text, computeKey(text))
    expect(result.applied).toBe(false)
  })

  it('declines an envelope it does not recognise rather than guessing', () => {
    // A write confirmation is an envelope too, but it has no numbered lines.
    const text = '<path>src/a.ts</path>\n<type>file</type>\n<content>\nUpdated file\n</content>'
    const result = skeletonizeReadOutput(text, computeKey(text))
    expect(result.applied).toBe(false)
    expect(result.output).toBe(text)
  })

  it('accepts a chunked read that starts at an offset', () => {
    // Agents read large files in windows, so a body beginning at `201: ` is the
    // common case, not an exotic one. An earlier version required the run to
    // start at 1 and silently declined every offset read.
    const all = typescriptSource().split('\n')
    const start = 41
    const window = all.slice(start - 1, start - 1 + 200)
    const body = window.map((line, index) => `${index + start}: ${line}`).join('\n')
    const text = `<path>src/loader.ts</path>\n<type>file</type>\n<content>\n${body}\n\n(Showing lines ${start}-${start - 1 + window.length} of ${all.length}. Use offset=${start + window.length} to continue.)\n</content>`
    const result = skeletonizeReadOutput(text, computeKey(text))
    expect(result.applied).toBe(true)
    expect(result.output).toContain('(Showing lines 41-')
  })

  it('declines a body whose line numbers are not consecutive', () => {
    // A gap means this is not the numbered format the heuristics understand, so
    // the safest answer is to leave the read exactly as it arrived.
    const body = ['1: const a = 1', '2: const b = 2', '9: const c = 3', '10: const d = 4'].join('\n')
    const text = `<path>src/gap.ts</path>\n<type>file</type>\n<content>\n${body}\n\n(End of file - total 4 lines)\n</content>`
    const result = skeletonizeReadOutput(text, computeKey(text))
    expect(result.applied).toBe(false)
    expect(result.output).toBe(text)
  })

  it('declines when the skeleton would not shrink enough to be worth the marker', () => {
    const text = readEnvelope('src/loader.ts', typescriptSource())
    const result = skeletonizeReadOutput(text, computeKey(text), { ...CODE_SKELETON_DEFAULTS, maxSizeRatio: 0.01 })
    expect(result.applied).toBe(false)
  })
})

describe('code skeleton — what survives', () => {
  const code = typescriptSource()
  const text = readEnvelope('src/loader.ts', code)
  const hash = computeKey(text)
  const result = skeletonizeReadOutput(text, hash)

  it('applies and reports honest counts', () => {
    expect(result.applied).toBe(true)
    expect(result.keptLines).toBeGreaterThan(0)
    expect(result.elidedLines).toBeGreaterThan(0)
    expect(result.keptLines + result.elidedLines).toBe(code.split('\n').length)
    expect(result.savings).toBeGreaterThan(0.3)
  })

  it('keeps the imports, doc comment, declarations and signatures byte-exact', () => {
    expect(result.output).toContain("import { readFile } from 'node:fs/promises'")
    expect(result.output).toContain(' * Module doc comment that belongs to the first declaration.')
    expect(result.output).toContain('export interface LoadedFile {')
    expect(result.output).toContain('export class FileLoader {')
    expect(result.output).toContain('  async load(name: string): Promise<LoadedFile> {')
    expect(result.output).toContain('  async loadMany(names: readonly string[]): Promise<readonly LoadedFile[]> {')
    expect(result.output).toContain('export function describeFile(file: LoadedFile): string {')
  })

  it('drops implementation bodies', () => {
    expect(result.output).not.toContain('this.cache.set(name, loaded)')
    expect(result.output).not.toContain('const kilobytes = Math.round(bytes / 1024)')
    expect(result.output).not.toContain('total += computeStep(7)')
  })

  it('keeps every retained line byte-identical to the original it came from', () => {
    // The contract: output lines carrying `N: ` are exactly the original lines
    // for those numbers. A single rewritten byte here would make an Edit
    // anchored on a retained line fail with no explanation.
    const original = new Map<string, string>()
    for (const raw of text.split('\n')) {
      const match = /^(\d+): (.*)$/.exec(raw)
      if (match !== null) original.set(match[1]!, raw)
    }
    let checked = 0
    for (const raw of result.output.split('\n')) {
      const match = /^\s*(\d+): /.exec(raw)
      if (match === null) continue
      expect(original.get(match[1]!)).toBe(raw)
      checked += 1
    }
    expect(checked).toBe(result.keptLines)
  })

  it('names truthful line ranges in every elision marker', () => {
    const markers = [...result.output.matchAll(/^\s*(\d+)-(\d+): \[elided (\d+) lines\]$/gmu)]
    expect(markers.length).toBe(result.runs)
    expect(markers.length).toBeGreaterThan(0)
    let elided = 0
    for (const [, from, to, count] of markers) {
      const start = Number(from)
      const end = Number(to)
      // The range must describe exactly the lines it claims to cover.
      expect(end - start + 1).toBe(Number(count))
      expect(end).toBeGreaterThanOrEqual(start)
      elided += Number(count)
    }
    expect(elided).toBe(result.elidedLines)
  })

  it('hands the caller a hash so the original stays retrievable', () => {
    expect(result.output).toContain(`headroom_retrieve hash=${hash}`)
    // The hash must address the *whole original*, not the skeleton.
    expect(hash).toHaveLength(24)
  })

  it('keeps the read footer, which describes the file rather than the excerpt', () => {
    expect(result.output).toContain('(End of file - total ')
  })

  it('keeps multi-line signatures whole instead of eliding their parameters', () => {
    const multi = [
      'export function configure(',
      '  firstArgument: string,',
      '  secondArgument: number,',
      '): { readonly first: string } {',
      '  const first = firstArgument',
      '  const second = secondArgument + 1',
      '  const third = `${first}:${second}`',
      '  return { first: third }',
      '}',
      ...paddingModule(),
    ].join('\n')
    const multiText = readEnvelope('src/configure.ts', multi)
    const multiResult = skeletonizeReadOutput(multiText, computeKey(multiText))
    expect(multiResult.applied).toBe(true)
    expect(multiResult.output).toContain('export function configure(')
    expect(multiResult.output).toContain('  firstArgument: string,')
    expect(multiResult.output).toContain('  secondArgument: number,')
    expect(multiResult.output).toContain('): { readonly first: string } {')
    expect(multiResult.output).not.toContain('return { first: third }')
  })

  it('does not mistake control flow or calls for declarations', () => {
    const source = [
      'export function run(items: readonly string[]): number {',
      '  let total = 0',
      '  for (const item of items) {',
      '    if (item.length > 2) {',
      '      total += item.length',
      '    }',
      '  }',
      '  console.log(total)',
      '  return total',
      '}',
      ...paddingModule(),
    ].join('\n')
    const sourceText = readEnvelope('src/run.ts', source)
    const sourceResult = skeletonizeReadOutput(sourceText, computeKey(sourceText))
    expect(sourceResult.applied).toBe(true)
    expect(sourceResult.output).toContain('export function run(items: readonly string[]): number {')
    expect(sourceResult.output).not.toContain('for (const item of items) {')
    expect(sourceResult.output).not.toContain('console.log(total)')
  })

  it('keeps class fields written as arrow functions, which carry no keyword', () => {
    const source = [
      'export class Handler {',
      '  private readonly name: string',
      '',
      '  onChange = (event: Event): void => {',
      '    const target = event.target',
      '    const value = String(target)',
      '    this.emit(value)',
      '  }',
      '',
      '  private emit(value: string): void {',
      '    const trimmed = value.trim()',
      '    this.sink(trimmed)',
      '  }',
      '}',
      ...paddingModule(),
    ].join('\n')
    const sourceText = readEnvelope('src/handler.ts', source)
    const sourceResult = skeletonizeReadOutput(sourceText, computeKey(sourceText))
    expect(sourceResult.applied).toBe(true)
    expect(sourceResult.output).toContain('  onChange = (event: Event): void => {')
    expect(sourceResult.output).toContain('  private emit(value: string): void {')
    expect(sourceResult.output).not.toContain('const trimmed = value.trim()')
  })
})

/**
 * A stand-in for the composition root: the runtime needs `ctx.on` to attach its
 * post-execute listener, `ctx.effect` to own the disposer, and `ctx.get('tools')`
 * to publish `headroom_retrieve`.
 */
function headroomHarness(initial: HeadroomSettings): {
  readonly runtime: FreeCodeGoHeadroomRuntime
  readonly set: (patch: Partial<HeadroomSettings>) => void
  readonly run: (exec: { readonly name: string }, result: { readonly isError?: boolean; readonly content: readonly unknown[] }) => Promise<{ readonly kind: string; readonly content?: readonly { readonly text: string }[] } | undefined>
  readonly retrieve: (hash: string) => Promise<unknown>
} {
  let current = initial
  const listeners = new Map<string, (exec: never, result: never, next: () => Promise<unknown>) => Promise<unknown>>()
  const tools = new Map<string, { execute: (args: { hash: string }) => Promise<unknown> }>()
  const ctx = {
    effect: (callback: () => unknown) => { callback() },
    on: (event: string, handler: unknown) => {
      listeners.set(event, handler as never)
      return () => undefined
    },
    get: (name: string) => name === 'tools'
      ? { register: (tool: { name: string }) => { tools.set(tool.name, tool as never); return () => undefined } }
      : undefined,
  }
  return {
    runtime: new FreeCodeGoHeadroomRuntime(ctx as unknown as Context, { get: () => current }),
    set: (patch) => { current = { ...current, ...patch } },
    run: async (exec, result) => {
      const listener = listeners.get('tools/post-execute')
      if (listener === undefined) return undefined
      return await listener(exec as never, result as never, async () => ({ kind: 'next' })) as never
    },
    retrieve: async (hash) => {
      const tool = tools.get('headroom_retrieve')
      if (tool === undefined) throw new Error('headroom_retrieve was not registered')
      return await tool.execute({ hash })
    },
  }
}

const baseSettings: HeadroomSettings = { headroomEnabled: true, headroomThresholdChars: 1_200 }

/** A read result big enough for the skeleton to accept, wrapped as a tool result. */
function largeRead(): { readonly text: string; readonly content: readonly { readonly type: 'text'; readonly text: string }[] } {
  const text = readEnvelope('src/loader.ts', typescriptSource())
  return { text, content: [{ type: 'text', text }] }
}

describe('code skeleton — runtime integration', () => {
  it('replaces a large read and keeps the original retrievable by hash', async () => {
    const harness = headroomHarness(baseSettings)
    harness.runtime.start()
    const read = largeRead()
    const outcome = await harness.run({ name: 'read' }, read)
    expect(outcome?.kind).toBe('accept')
    const skeleton = outcome?.content?.[0]?.text ?? ''
    expect(skeleton).toContain('[elided ')
    expect(skeleton).toContain('headroom_retrieve hash=')
    expect(harness.runtime.status().codeSkeletonCompressions).toBe(1)
    expect(harness.runtime.status().ccrEntries).toBe(1)
    // The hash in the marker must address the original bytes, not the skeleton.
    const hash = /headroom_retrieve hash=([a-f0-9]{24})/u.exec(skeleton)?.[1] ?? ''
    expect(hash).toHaveLength(24)
    await expect(harness.retrieve(hash)).resolves.toBe(read.text)
  })

  it('leaves the read byte-exact when the switch is off', async () => {
    const harness = headroomHarness({ ...baseSettings, headroomCodeSkeletonEnabled: false })
    harness.runtime.start()
    const outcome = await harness.run({ name: 'read' }, largeRead())
    // No content replacement: the waterfall falls through to `next`.
    expect(outcome?.kind).toBe('next')
    expect(harness.runtime.status().codeSkeletonCompressions).toBe(0)
    expect(harness.runtime.status().ccrEntries).toBe(0)
  })

  it('never touches a failed read, which the model needs verbatim to recover', async () => {
    const harness = headroomHarness(baseSettings)
    harness.runtime.start()
    const read = largeRead()
    const outcome = await harness.run({ name: 'read' }, { ...read, isError: true })
    expect(outcome?.kind).toBe('next')
    expect(harness.runtime.status().codeSkeletonCompressions).toBe(0)
  })

  it('ignores tools that are not reads, however code-like their output', async () => {
    const harness = headroomHarness(baseSettings)
    harness.runtime.start()
    const outcome = await harness.run({ name: 'bash' }, largeRead())
    expect(outcome?.kind).toBe('next')
    expect(harness.runtime.status().codeSkeletonCompressions).toBe(0)
  })

  it('reports the switch it is reading, including its on-by-default value', () => {
    expect(headroomHarness(baseSettings).runtime.status().codeSkeletonEnabled).toBe(true)
    expect(headroomHarness({ ...baseSettings, headroomCodeSkeletonEnabled: false }).runtime.status().codeSkeletonEnabled).toBe(false)
  })

  it('reflects a later settings write without being rebuilt', () => {
    const harness = headroomHarness({ ...baseSettings, headroomCodeSkeletonEnabled: false })
    expect(harness.runtime.status().codeSkeletonEnabled).toBe(false)
    harness.set({ headroomCodeSkeletonEnabled: true })
    expect(harness.runtime.status().codeSkeletonEnabled).toBe(true)
  })
})

describe('code skeleton — eligibility', () => {
  it('accepts read tools and rejects everything else', () => {
    for (const name of ['read', 'read_file', 'view', 'Read', 'READ_FILE']) {
      expect(isSkeletonEligibleTool(name)).toBe(true)
    }
    for (const name of ['bash', 'pwsh', 'grep', 'glob', 'edit', 'write', 'web_fetch', 'headroom_retrieve']) {
      expect(isSkeletonEligibleTool(name)).toBe(false)
    }
  })
})

/**
 * The gate the skeleton arrives through.
 *
 * The runtime asks {@link isSkeletonEligibleTool} only for a tool the safety gate
 * classified as protected, so the protection set is not a sibling of this feature
 * — it is the door. The settings field for extra protected tools is
 * `z.array(z.string()).default([])`, which resolves to a *present, empty* array on
 * every install that has never touched it. Read as a replacement for the built-in
 * set, that empty array protected nothing: the skeleton could not run at all
 * (while the panel kept reporting it as enabled), and every tool result —
 * including the reads the model byte-patches against — became eligible for the
 * lossy strategies the built-in set exists to keep away from it.
 */
describe('code skeleton — the protection gate it arrives through', () => {
  it('skeletonizes a read when the settings carry the schema-resolved empty addition list', async () => {
    const harness = headroomHarness({ ...baseSettings, headroomExcludeTools: [] })
    harness.runtime.start()
    const outcome = await harness.run({ name: 'read' }, largeRead())
    expect(outcome?.kind).toBe('accept')
    expect(harness.runtime.status().protectedCount).toBe(1)
    expect(harness.runtime.status().codeSkeletonCompressions).toBe(1)
  })

  it('protects every spelling the skeleton claims, so none is eligible and unprotected at once', async () => {
    // The agreement is the invariant, and the failure it prevents is silent: an
    // eligible-but-unprotected spelling is a branch that can never run, which is
    // how `readfile` came to sit in one list and not the other.
    for (const name of READ_LIKE_TOOL_NAMES) {
      const harness = headroomHarness({ ...baseSettings, headroomExcludeTools: [] })
      harness.runtime.start()
      const outcome = await harness.run({ name }, largeRead())
      expect(outcome?.kind, name).toBe('accept')
      expect(harness.runtime.status().protectedCount, name).toBe(1)
    }
  })

  it('leaves a byte-patch tool’s view byte-exact, which is what its old_str is copied from', async () => {
    // `str_replace_editor` patches with an `old_str` copied out of a previous
    // view, so a rewritten view is an edit that matches nothing. The body is a
    // *measured* shape rather than an arbitrary one: a log-shaped read is what
    // the search compressor accepts (it drops non-matching lines and leaves a
    // marker), which is the rewrite this tool must never receive. Run against an
    // unprotected tool the same bytes come back as `accept` with
    // `searchCompressions === 1`.
    const body = Array.from(
      { length: 300 },
      (_, index) => `2026-09-18T06:0${index % 10}:00.000Z INFO worker ${index} handled request id=${index} in ${index % 90}ms`,
    ).join('\n')
    const view = readEnvelope('var/app.log', body)
    const harness = headroomHarness(baseSettings)
    harness.runtime.start()
    const outcome = await harness.run({ name: 'str_replace_editor' }, { content: [{ type: 'text' as const, text: view }] })
    expect(outcome?.kind).toBe('next')
    expect(harness.runtime.status().protectedCount).toBe(1)
    expect(harness.runtime.status().compressions).toBe(0)
    expect(harness.runtime.status().searchCompressions).toBe(0)
  })

  it('still protects a tool the user adds on top of the built-in set', async () => {
    // The field's documented job, and the reason the rule is a union rather than
    // "ignore the built-ins when the field is set": permission to add, not
    // permission to subtract.
    const harness = headroomHarness({ ...baseSettings, headroomExcludeTools: ['my_custom_reader'] })
    harness.runtime.start()
    const outcome = await harness.run({ name: 'my_custom_reader' }, largeRead())
    expect(outcome?.kind).toBe('next')
    expect(harness.runtime.status().protectedCount).toBe(1)
  })
})
