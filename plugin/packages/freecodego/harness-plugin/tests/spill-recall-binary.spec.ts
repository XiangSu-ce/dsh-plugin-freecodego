/**
 * `spill_recall` over an artifact that is not valid UTF-8.
 *
 * The paging interface is byte offsets, and the acceptance property the module
 * states is that concatenating the pages of an artifact reconstructs its bytes
 * exactly. Off disk, the figures that decide "which bytes did this page carry and
 * which come next" were computed on a *decoded string* and then added to file
 * offsets: on valid UTF-8 the two coordinate systems coincide, so every existing
 * case was green, and on anything else they diverge — an invalid byte decodes to
 * U+FFFD and re-encodes as three bytes, so offsets ran ahead of the file, pages
 * ran out early, and the tail of the artifact was never served. A GBK console log
 * (code page 936) is the everyday instance of that, and a locator is any path the
 * model names.
 *
 * These cases page each artifact from zero and assert that the pages **partition
 * the file's bytes**: offsets are contiguous, each page's text is exactly the
 * decoding of the file slice it claims, every page advances, and `eof` arrives
 * only at the real end. The retreat rule is pinned separately, on byte arrays,
 * because a page that starts before the offset it was asked for is the same defect
 * seen from the other side.
 */

import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { FreeCodeGoHarnessPlugin } from '../src/index.ts'
import { characterStartIndex, readSpillPageBytes } from '../src/spill-recall.ts'
import { provideHostService, provideHostServiceAs, type AgentEnginesFace } from './support/host-services.ts'

/** What `recallSpill` answers with, narrowed to the fields these cases read. */
interface RecallPage {
  readonly available: boolean
  readonly text?: string
  readonly bytes?: number
  readonly offset?: number
  readonly nextOffset?: number
  readonly eof?: boolean
  readonly totalBytes?: number
  readonly note?: string
}

const directories: string[] = []
let suiteRoot = ''
const previousHome = process.env.DSH_HOME
let recall!: (args: { readonly locator?: string; readonly offset?: number; readonly max_bytes?: number }) => Promise<RecallPage>
let dispose!: () => Promise<void>

/** The two services the plugin constructor reads, as `plugin.spec.ts` provides them. */
function AgentEngineRegistry(ctx: Context): void {
  provideHostServiceAs<AgentEnginesFace>(ctx, 'agentEngines', { setAvailability: () => undefined })
  provideHostService(ctx, 'agents', { list: () => [], get: () => undefined })
}

beforeAll(async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'freecodego-spill-binary-'))
  suiteRoot = sandbox
  process.env.DSH_HOME = sandbox
  await mkdir(join(sandbox, 'profiles', 'default'), { recursive: true })
  const ctx = new Context()
  await ctx.plugin(AgentEngineRegistry)
  const plugin = new FreeCodeGoHarnessPlugin(ctx, {}) as unknown as {
    recallSpill: (args: { readonly locator?: string; readonly offset?: number; readonly max_bytes?: number }) => Promise<RecallPage>
  }
  recall = args => plugin.recallSpill(args)
  dispose = async () => { await ctx.fiber.dispose() }
})

// `maxRetries`/`retryDelay` for the reason the neighbouring spill suites carry them:
// the window this file reads is held by a file handle whose release on Windows
// outlives the await that saw it close, and a bare `rm` then fails the file with
// `ENOTEMPTY` after its assertions have already passed.
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })))
})

afterAll(async () => {
  await dispose()
  await rm(suiteRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
})

/**
 * The three artifacts, as byte arrays.
 *
 * The first is the one the audit measured: `"A\n"`, two bytes that are not valid
 * UTF-8, `"B\n"`, another invalid byte, then `"(C"` — nine bytes, of which two
 * decode to U+FFFD. The second is a GBK-encoded Chinese line, whose every
 * character is invalid UTF-8 (the everyday shape: a Windows console log). The
 * third is valid UTF-8 and is the control: a change that fixes the first two by
 * breaking ordinary text has to fail loudly rather than in a suite nobody re-runs.
 */
const ARTIFACTS: readonly (readonly [string, readonly number[]])[] = [
  ['mixed invalid bytes', [0x41, 0x0a, 0x80, 0x80, 0x42, 0x0a, 0xc3, 0x28, 0x43]],
  ['gbk console log', [0xd6, 0xd0, 0xce, 0xc4, 0x0a, 0xb2, 0xe2, 0xca, 0xd4, 0x0a]],
  ['valid utf-8', [...Buffer.from('héllo\nwörld\n', 'utf8')]],
]

async function artifactFile(name: string, raw: readonly number[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'freecodego-spill-artifact-'))
  directories.push(directory)
  const file = join(directory, `${name.replaceAll(' ', '-')}.log`)
  await writeFile(file, Buffer.from(raw))
  return file
}

/** Page a file from zero until `eof`, returning every page in order. */
async function pageThrough(locator: string, maxBytes: number): Promise<readonly RecallPage[]> {
  const pages: RecallPage[] = []
  let offset = 0
  for (let step = 0; step < 200; step += 1) {
    const page = await recall({ locator, offset, max_bytes: maxBytes })
    pages.push(page)
    expect(page.available, page.note).toBe(true)
    if (page.eof === true) break
    const next = page.nextOffset ?? offset
    if (next <= offset) throw new Error(`page at ${offset} did not advance (nextOffset=${String(page.nextOffset)})`)
    offset = next
  }
  return pages
}

describe('paging an artifact that is not valid UTF-8', () => {
  for (const [name, raw] of ARTIFACTS) {
    it(`partitions ${name} byte for byte, with no byte lost and none served twice`, async () => {
      const file = await artifactFile(name, raw)
      const source = Buffer.from(raw)
      const pages = await pageThrough(file, 4)
      let cursor = 0
      for (const [index, page] of pages.entries()) {
        // Contiguous: each page begins exactly where the previous one stopped, and
        // the first begins at zero.
        expect(page.offset, `page ${String(index)} must start at ${String(cursor)}`).toBe(cursor)
        const next = page.nextOffset ?? 0
        expect(next, `page ${String(index)} must advance`).toBeGreaterThan(cursor)
        expect(next).toBeLessThanOrEqual(source.length)
        // The text is the decoding of the file bytes it claims — the whole of them
        // and nothing else, which is what makes "reconstructs the bytes" checkable
        // without trusting the returned counters.
        expect(page.text, `page ${String(index)} text must decode bytes [${String(cursor)}, ${String(next)})`)
          .toBe(source.subarray(cursor, next).toString('utf8'))
        expect(page.bytes).toBe(next - cursor)
        cursor = next
      }
      // The walk ends at the end of the file, not short of it, and `eof` was not
      // reported earlier than that.
      expect(cursor).toBe(source.length)
      for (const page of pages.slice(0, -1)) expect(page.eof).toBe(false)
      expect(pages.at(-1)?.eof).toBe(true)
    })
  }

  it('serves the tail the string round trip used to lose', async () => {
    // The measured failure, stated as the observable it produced: paging the nine
    // bytes above reached `eof` with `B`, the second newline and `(C` never served.
    // Those bytes are ASCII, so they arrive as themselves however the two invalid
    // ones decode — which is what lets the assertion be about the *bytes* served
    // rather than about a count that a broken page could still get right.
    const file = await artifactFile('mixed invalid bytes', ARTIFACTS[0]![1])
    const pages = await pageThrough(file, 4)
    const served = pages.map(page => page.text ?? '').join('')
    expect(served).toContain('B')
    expect(served).toContain('(C')
    expect(pages.at(-1)?.nextOffset).toBe(9)
    expect(pages.at(-1)?.totalBytes).toBe(9)
  })
})

describe('the retreat off a character boundary', () => {
  const bytes = (...values: readonly number[]): Uint8Array => Uint8Array.from(values)

  it('lands on the sequence that covers the requested offset', () => {
    // A two-byte character: the request inside it retreats to its lead byte.
    expect(characterStartIndex(bytes(0x41, 0xc3, 0xa9, 0x42), 2)).toBe(1)
    // A four-byte character, requested at its last byte.
    expect(characterStartIndex(bytes(0xf0, 0x9f, 0x98, 0x80), 3)).toBe(0)
  })

  it('does not walk past a character onto bytes already served', () => {
    // `A\n` then two bytes that are not valid UTF-8. Requesting the second of them
    // must not retreat to the newline: the newline is a one-byte character and does
    // not cover offset 3, and serving from 2 would re-send the byte at 2.
    const invalid = bytes(0x41, 0x0a, 0x80, 0x80, 0x42)
    expect(characterStartIndex(invalid, 3)).toBe(3)
    expect(characterStartIndex(invalid, 2)).toBe(2)
  })

  it('keeps a page that starts on an isolated byte from replaying the one before it', () => {
    // The byte-domain page itself: asked for offset 2 of the pair, it serves from 2
    // and advances by one byte rather than replaying the byte at 1.
    const page = readSpillPageBytes(bytes(0x41, 0x0a, 0x80, 0x80, 0x42), { offset: 2, maxBytes: 1 })
    expect(page.offset).toBe(2)
    expect(page.nextOffset).toBeGreaterThan(2)
  })
})
