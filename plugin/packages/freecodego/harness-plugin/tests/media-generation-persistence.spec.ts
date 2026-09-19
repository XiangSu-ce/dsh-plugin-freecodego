import { existsSync } from 'node:fs'
import fsDefault from 'node:fs/promises'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateAudioWithFallback } from '../src/media-generation.ts'

/**
 * The generated audio is the only media this module writes to disk itself —
 * images travel through the attachment store and videos stay provider URLs — so
 * it is the one place the atomic-publish contract can be observed from outside.
 *
 * `AUDIO_BYTES` carries a real MP3 frame sync (`FF FB`) plus bytes above 0x7f.
 * The high bytes are the point: a publish that routes binary content through a
 * UTF-8 string re-encodes them into two bytes each, so a round trip that only
 * checks the file exists would still pass on a corrupted file.
 */
const AUDIO_BYTES = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x7f, 0x80, 0xc3, 0xa9, 0x0d, 0x0a])

const mediaDirectory = (workspace: string): string => join(workspace, '.freecodego', 'generated-media')

/** Staging siblings still present in the media directory, if it exists at all. */
async function stagingSiblings(workspace: string): Promise<string[]> {
  try {
    return (await readdir(mediaDirectory(workspace))).filter(entry => entry.endsWith('.tmp'))
  } catch {
    return []
  }
}

interface MediaWrite {
  readonly path: string
  readonly mode: number | undefined
  readonly flag: string | undefined
}

const state = {
  writes: [] as MediaWrite[],
  renames: [] as Array<{ readonly from: string; readonly to: string }>,
  /** Whether the final path already existed when the commit rename ran. */
  targetExistedAtRename: undefined as boolean | undefined,
  /** Whether the staging sibling still existed when the commit rename ran. */
  stagingExistedAtRename: undefined as boolean | undefined,
  /** Directory whose next write is truncated and then failed. */
  truncateWriteInside: undefined as string | undefined,
  failNextRename: false,
}

// The module reads `node:fs/promises` through its default export, so the spies
// go on that same object: a named-export mock would not reach the call sites.
const originalWriteFile = fsDefault.writeFile
const originalRename = fsDefault.rename

function installRecorder(): void {
  vi.spyOn(fsDefault, 'writeFile').mockImplementation((async (file: unknown, data: unknown, ...rest: unknown[]) => {
    const options = rest[0] as { readonly mode?: number; readonly flag?: string } | undefined
    state.writes.push({ path: String(file), mode: options?.mode, flag: options?.flag })
    if (state.truncateWriteInside !== undefined && dirname(String(file)) === state.truncateWriteInside) {
      state.truncateWriteInside = undefined
      // Half the payload reaches the destination and then the write fails, which
      // is exactly the shape a direct `writeFile` leaves on disk when the process
      // dies or the disk fills. Where that half lands is the whole question.
      const bytes = data as Uint8Array
      await (originalWriteFile as never as (target: unknown, content: unknown, ...args: unknown[]) => Promise<void>)(file, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))), ...rest)
      throw Object.assign(new Error('ENOSPC: injected media write failure'), { code: 'ENOSPC' })
    }
    return (originalWriteFile as never as (target: unknown, content: unknown, ...args: unknown[]) => Promise<void>)(file, data, ...rest)
  }) as typeof originalWriteFile)
  vi.spyOn(fsDefault, 'rename').mockImplementation((async (from: unknown, to: unknown) => {
    state.renames.push({ from: String(from), to: String(to) })
    state.targetExistedAtRename = existsSync(String(to))
    state.stagingExistedAtRename = existsSync(String(from))
    if (state.failNextRename) {
      state.failNextRename = false
      throw Object.assign(new Error('EPERM: injected rename failure'), { code: 'EPERM' })
    }
    return (originalRename as never as (source: unknown, target: unknown) => Promise<void>)(from, to)
  }) as typeof originalRename)
}

const workspaces: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  state.writes.length = 0
  state.renames.length = 0
  state.targetExistedAtRename = undefined
  state.stagingExistedAtRename = undefined
  state.truncateWriteInside = undefined
  state.failNextRename = false
  await Promise.all(workspaces.splice(0).map(workspace => rm(workspace, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'fcg-media-persist-'))
  workspaces.push(directory)
  return directory
}

/** The single-route audio host the media fallback chain needs to reach the write. */
const audioHost = (): unknown => ({
  ctx: { get: (name: string) => name === 'llm' ? { listProviders: () => [], listModels: async () => [] } : undefined },
  credentials: { resolve: async () => undefined },
  capabilities: { configuration: () => ({ modelCategories: {} }) },
  policy: { get: () => ({ mediaDefaults: { audio: 'audio-model' } }) },
  readManagedCatalogCache: async () => undefined,
  logfareApiKey: async () => undefined,
  requireAgnes: () => ({ agnesMediaModels: async () => [] }),
  mediaRoute: (selection: string) => ({ selection, provider: 'freecodego', model: 'audio-model' }),
  directConnection: async () => undefined,
  managedRuntime: async () => ({ openAIBaseUrl: 'https://gateway.example/v1', openAIToken: 'token', routeKey: 'rk' }),
})

/** Serve `AUDIO_BYTES` as a provider binary response and record the published path. */
async function generateAudio(cwd: string): Promise<string> {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(AUDIO_BYTES, { status: 200, headers: { 'content-type': 'audio/mpeg' } }))
  const result = await generateAudioWithFallback(audioHost() as never, { input: 'hello' }, cwd, new AbortController().signal) as { readonly path: string }
  return result.path
}

describe('generated audio persistence', () => {
  it('renames a staging sibling over the target instead of writing the target directly', async () => {
    const cwd = await workspace()
    installRecorder()
    // The target cannot exist before the publish: the media directory is created
    // by this call alone.
    expect(existsSync(mediaDirectory(cwd))).toBe(false)

    const file = await generateAudio(cwd)

    // One commit, and it is a rename: `writeFile` never received the final path,
    // so no reader can observe a partially written media file.
    expect(state.renames).toEqual([{ from: expect.stringContaining(`${file}.`), to: file }])
    expect(state.renames[0]?.from.endsWith('.tmp')).toBe(true)
    expect(dirname(state.renames[0]!.from)).toBe(dirname(file))
    expect(state.writes.map(entry => entry.path)).not.toContain(file)
    // The rename is what collapses the window: at the instant it ran, the
    // complete payload was staged and the target was still absent.
    expect(state.targetExistedAtRename).toBe(false)
    expect(state.stagingExistedAtRename).toBe(true)
  })

  it('stages the media bytes with mode 0600 and an exclusive-create flag', async () => {
    const cwd = await workspace()
    installRecorder()

    const file = await generateAudio(cwd)

    // `mode` and `flag` are asserted on the intercepted call rather than on the
    // published file, because that is the only form that holds on every platform
    // (see the conditional `stat` below).
    const staged = state.writes.find(entry => entry.path.endsWith('.tmp'))
    expect(staged?.mode).toBe(0o600)
    // `wx` refuses to follow a symlink planted at the staging path and keeps a
    // concurrent generation out of this write's staging file.
    expect(staged?.flag).toBe('wx')

    // Windows synthesizes `mode` from the read-only attribute instead of POSIX
    // permission bits, so 0600 is not observable there. The intercepted-call
    // assertions above are what carry the requirement on Windows; this one is the
    // end-to-end proof where the filesystem actually stores the bits.
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('leaves no staging sibling behind after a successful publish', async () => {
    const cwd = await workspace()
    installRecorder()

    const file = await generateAudio(cwd)

    expect(await stagingSiblings(cwd)).toEqual([])
    expect(await readdir(mediaDirectory(cwd))).toEqual([basename(file)])
  })

  it('round-trips the provider bytes without re-encoding them', async () => {
    const cwd = await workspace()
    installRecorder()

    const file = await generateAudio(cwd)

    // Byte equality, not just existence: routing this payload through a UTF-8
    // string would double every byte above 0x7f and still leave a readable file.
    expect(new Uint8Array(await readFile(file))).toEqual(AUDIO_BYTES)
  })

  it('keeps the target absent and removes the staging file when the write fails midway', async () => {
    const cwd = await workspace()
    installRecorder()
    state.truncateWriteInside = mediaDirectory(cwd)

    // The staging failure is what surfaces: the cleanup below must not replace
    // it with an error of its own.
    await expect(generateAudio(cwd)).rejects.toThrow(/ENOSPC: injected media write failure/)

    // A direct write would have published the truncated half at the target path;
    // the staging sibling is where it lands instead, and the failure removes it.
    // The directory itself survives (it is created before the write), so the
    // assertion is that it holds no media and no orphan staging file.
    expect(await readdir(mediaDirectory(cwd))).toEqual([])
    expect(await stagingSiblings(cwd)).toEqual([])
  })

  it('keeps the target absent and removes the staging file when the rename fails', async () => {
    const cwd = await workspace()
    installRecorder()
    state.failNextRename = true

    await expect(generateAudio(cwd)).rejects.toThrow(/EPERM: injected rename failure/)

    // The payload was staged completely, so the commit is the only step that can
    // fail here — and it must not leave an orphan for the next run to trip over.
    expect(state.stagingExistedAtRename).toBe(true)
    expect(await readdir(mediaDirectory(cwd))).toEqual([])
    expect(await stagingSiblings(cwd)).toEqual([])
  })
})
