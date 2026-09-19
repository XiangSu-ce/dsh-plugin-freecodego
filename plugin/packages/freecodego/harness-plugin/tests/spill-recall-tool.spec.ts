/**
 * `spill_recall` over a real file handle.
 *
 * `spill-recall.spec.ts` tests the paging contract with the artifact in memory.
 * The tool pages the same artifact a second way — a window read off disk — and
 * that second way is where the rule about characters was missing: an offset that
 * landed inside a multi-byte character was used as asked, so the page began with
 * the replacement characters of a half-decoded character and every byte after it
 * was shifted; the answer also echoed the requested offset rather than the one it
 * served, which is the "corrected in silence" the in-memory page documents
 * itself as never doing.
 *
 * The cases below pin the two halves of that: the retreat itself, and the
 * agreement between the two paths, which is the property that keeps a future
 * change from fixing one and forgetting the other.
 */

import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { FreeCodeGoHarnessPlugin } from '../src/index.ts'
import { readSpillPage } from '../src/spill-recall.ts'
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
let recall!: (args: { readonly locator?: string; readonly offset?: number; readonly max_bytes?: number; readonly max_lines?: number }) => Promise<RecallPage>
let dispose!: () => Promise<void>

/** The two services the plugin constructor reads, as `plugin.spec.ts` provides them. */
function AgentEngineRegistry(ctx: Context): void {
  provideHostServiceAs<AgentEnginesFace>(ctx, 'agentEngines', { setAvailability: () => undefined })
  provideHostService(ctx, 'agents', { list: () => [], get: () => undefined })
}

beforeAll(async () => {
  // Kept out of `directories`: the per-test clean-up must not delete the data
  // home the plugin was constructed against.
  const sandbox = await mkdtemp(join(tmpdir(), 'freecodego-spill-tool-'))
  suiteRoot = sandbox
  process.env.DSH_HOME = sandbox
  await mkdir(join(sandbox, 'profiles', 'default'), { recursive: true })
  const ctx = new Context()
  await ctx.plugin(AgentEngineRegistry)
  const plugin = new FreeCodeGoHarnessPlugin(ctx, {}) as unknown as {
    recallSpill: (args: { readonly locator?: string; readonly offset?: number; readonly max_bytes?: number; readonly max_lines?: number }) => Promise<RecallPage>
  }
  recall = args => plugin.recallSpill(args)
  dispose = async () => { await ctx.fiber.dispose() }
})

// `maxRetries`/`retryDelay`, like every other suite that pages a file off disk:
// the artifact's handle is released by the OS after the await that saw it close,
// and in a full parallel run the bare `rm` then failed this *file* — after all of
// its tests had passed — with `ENOTEMPTY`. Recorded in §29.9 and again in §35.5;
// this is the last site that was still missing the retry.
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })))
})

afterAll(async () => {
  await dispose()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(suiteRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
})

/** A parked artifact whose every character but the ASCII parts is three bytes. */
const CONTENT = '中文日志：第一行\n第二行内容🙂\n第三行结束\n'
const CONTENT_BYTES = Buffer.from(CONTENT, 'utf8')

async function parked(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'freecodego-spill-file-'))
  directories.push(directory)
  const artifact = join(directory, 'parked.txt')
  await writeFile(artifact, CONTENT, 'utf8')
  return artifact
}

describe('spill_recall over a file handle', () => {
  it('retreats an offset inside a character and reports the offset it served', async () => {
    // Byte 1 of this artifact is the second byte of the three-byte 中. The
    // in-memory reader retreats to 0 and serves the whole character; the tool
    // used to serve "\uFFFD\uFFFD文日志…" from byte 1 and say offset: 1.
    const artifact = await parked()
    const page = await recall({ locator: artifact, offset: 1, max_bytes: 64 })
    expect(page.available).toBe(true)
    expect(page.offset).toBe(0)
    expect(page.text).not.toContain('\uFFFD')
    // And the text is the artifact from the offset that was served, not a
    // shifted copy of it.
    expect(page.text).toBe(CONTENT)
  })

  it('leaves an aligned offset alone', async () => {
    const artifact = await parked()
    const page = await recall({ locator: artifact, offset: 3, max_bytes: 3 })
    expect(page.offset).toBe(3)
    expect(page.text).toBe('文')
    expect(page.bytes).toBe(3)
  })

  it('agrees with the in-memory reader about where a character starts', async () => {
    // The property that keeps this from being two rules again: for every offset
    // in and around the first characters, the byte the tool serves is the byte
    // `readSpillPage` would start at.
    const artifact = await parked()
    for (const requested of [0, 1, 2, 3, 4, 5, 6, 7, 8, 17, 18, 30]) {
      const fromDisk = await recall({ locator: artifact, offset: requested, max_bytes: 16 })
      const inMemory = readSpillPage(CONTENT, { offset: requested, maxBytes: 16 })
      expect(fromDisk.offset, `offset ${requested}`).toBe(inMemory.offset)
    }
  })

  it('pages the whole artifact back byte for byte', async () => {
    // The tool-level acceptance property: small pages, walked to eof, rebuild the
    // parked bytes exactly.
    const artifact = await parked()
    const served: string[] = []
    let offset = 0
    for (let guard = 0; guard < 500; guard += 1) {
      const page = await recall({ locator: artifact, offset, max_bytes: 7 })
      expect(page.available).toBe(true)
      served.push(page.text ?? '')
      if (page.eof === true) break
      expect(page.nextOffset).toBeGreaterThan(offset)
      offset = page.nextOffset ?? 0
    }
    expect(Buffer.from(served.join(''), 'utf8').equals(CONTENT_BYTES)).toBe(true)
    expect(served.length).toBeGreaterThan(1)
  })

  it('refuses an offset out of range and answers an empty last page at the end', async () => {
    const artifact = await parked()
    const past = await recall({ locator: artifact, offset: CONTENT_BYTES.byteLength + 1 })
    expect(past.available).toBe(false)
    expect(String(past.note)).toContain('past the end')
    const atEnd = await recall({ locator: artifact, offset: CONTENT_BYTES.byteLength })
    expect(atEnd).toMatchObject({ available: true, text: '', eof: true, totalBytes: CONTENT_BYTES.byteLength })
  })
})
