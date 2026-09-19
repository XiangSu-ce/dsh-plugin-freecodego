import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { FreeCodeGoPluginUpdateService } from '../src/plugin-update.ts'

/**
 * The pending-update marker is the transaction log for an update: its
 * `promoting` flag is what tells the next startup to restore the retained
 * manifests, and its absence after a completed install is what tells the next
 * startup the new bundle is live. A process that dies mid-write therefore does
 * not merely lose a file — it leaves a truncated document where the next boot
 * reads its own recovery instructions.
 *
 * `src/plugin-update.ts` reaches `node:fs/promises` through named imports, so
 * the default-export spy used by `media-generation-persistence.spec.ts` would
 * not reach the call sites; this module is mocked instead, with every function
 * delegating to the real one.
 */
const recorder = vi.hoisted(() => ({
  writes: [] as Array<{ readonly path: string; readonly mode: number | undefined; readonly flag: string | undefined }>,
  renames: [] as Array<{ readonly from: string; readonly to: string }>,
  /** Whether the final path already existed when the commit rename ran. */
  targetExistedAtRename: undefined as boolean | undefined,
  /** Whether the staging sibling still existed when the commit rename ran. */
  stagingExistedAtRename: undefined as boolean | undefined,
  /** Directory whose next write is truncated and then failed. */
  truncateWriteInside: undefined as string | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const writeFileActual = actual.writeFile as never as (target: unknown, content: unknown, options?: unknown) => Promise<void>
  const renameActual = actual.rename as never as (source: unknown, target: unknown) => Promise<void>
  return {
    ...actual,
    writeFile: async (file: unknown, data: unknown, options?: unknown) => {
      const settings = options as { readonly mode?: number; readonly flag?: string } | undefined
      recorder.writes.push({ path: String(file), mode: settings?.mode, flag: settings?.flag })
      if (recorder.truncateWriteInside !== undefined && dirname(String(file)) === recorder.truncateWriteInside) {
        recorder.truncateWriteInside = undefined
        // Half the document reaches the destination and then the write fails,
        // which is exactly the shape a direct `writeFile` leaves on disk when the
        // process dies or the disk fills. Where that half lands is the question.
        const text = String(data)
        await writeFileActual(file, text.slice(0, Math.max(1, Math.floor(text.length / 2))), options)
        throw Object.assign(new Error('ENOSPC: injected marker write failure'), { code: 'ENOSPC' })
      }
      return writeFileActual(file, data, options)
    },
    rename: async (from: unknown, to: unknown) => {
      recorder.renames.push({ from: String(from), to: String(to) })
      recorder.targetExistedAtRename = existsSync(String(to))
      recorder.stagingExistedAtRename = existsSync(String(from))
      return renameActual(from, to)
    },
  }
})

const HARNESS = '0.1.3-alpha.1'
const MARKER_NAME = '.dsh-freecodego-update-pending.json'

const markerPath = (profile: string): string => join(profile, MARKER_NAME)

function settings() {
  const value: Record<string, unknown> = { pluginUpdateChecksEnabled: true }
  return { get: () => value as { pluginUpdateChecksEnabled: boolean }, update: vi.fn(async () => undefined) }
}

function resetRecorder(): void {
  recorder.writes.length = 0
  recorder.renames.length = 0
  recorder.targetExistedAtRename = undefined
  recorder.stagingExistedAtRename = undefined
}

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  resetRecorder()
  recorder.truncateWriteInside = undefined
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/**
 * A profile holding an un-promoted marker written by another process, whose
 * target version is not the one installed.
 *
 * The constructor's recovery task then records one more startup attempt, which
 * is the marker rewrite under test. The dependency is a `link:`, which keeps the
 * check itself offline: the marker write is the only write this spec measures.
 */
async function profileAwaitingRecovery(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'freecodego-marker-atomic-'))
  roots.push(root)
  const profile = join(root, 'freecodego-latest')
  await mkdir(join(profile, 'node_modules', 'freecodego'), { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ dependencies: { freecodego: 'link:../../../packages/freecodego/bundle-latest' } }))
  await writeFile(join(profile, 'node_modules', 'freecodego', 'package.json'), JSON.stringify({ version: HARNESS, freecodego: { harnessBaseline: HARNESS } }))
  await writeFile(markerPath(profile), JSON.stringify({
    version: 1,
    packageName: 'freecodego',
    targetVersion: '9.9.9',
    backupDirectory: join(dirname(profile), '.freecodego-latest-freecodego-backup-atomic'),
    attempts: 0,
    // A foreign process is what makes the recovery task run at all.
    processId: process.pid + 1,
  }))
  return profile
}

/** Construct the service and let its recovery task perform the marker rewrite. */
async function rewriteMarker(profile: string): Promise<void> {
  resetRecorder()
  const service = new FreeCodeGoPluginUpdateService({ settings: settings() as never, profilePath: profile })
  await service.check(true)
}

/** Staging siblings still present in the profile, if any. */
async function stagingSiblings(profile: string): Promise<string[]> {
  return (await readdir(profile)).filter(entry => entry.endsWith('.tmp'))
}

describe('pending-update marker persistence', () => {
  it('renames a staging sibling over the marker instead of writing it directly', async () => {
    const profile = await profileAwaitingRecovery()
    const marker = markerPath(profile)
    const before = JSON.parse(await readFile(marker, 'utf8')) as { readonly attempts: number }

    await rewriteMarker(profile)

    // One commit, and it is a rename: `writeFile` never received the marker path,
    // so no reader can observe a partially written marker.
    expect(recorder.renames).toEqual([{ from: expect.stringContaining(`${marker}.`), to: marker }])
    expect(recorder.renames[0]?.from.endsWith('.tmp')).toBe(true)
    expect(dirname(recorder.renames[0]!.from)).toBe(dirname(marker))
    expect(recorder.writes.map(entry => entry.path)).not.toContain(marker)
    // At the instant the rename ran, the complete document was staged and the
    // marker still held its previous contents.
    expect(recorder.targetExistedAtRename).toBe(true)
    expect(recorder.stagingExistedAtRename).toBe(true)
    // The rewrite landed: recovery recorded its next attempt.
    expect(JSON.parse(await readFile(marker, 'utf8'))).toMatchObject({ attempts: before.attempts + 1 })
  })

  it('stages the marker with mode 0600 and an exclusive-create flag', async () => {
    const profile = await profileAwaitingRecovery()

    await rewriteMarker(profile)

    const staged = recorder.writes.find(entry => entry.path.endsWith('.tmp'))
    expect(staged?.mode).toBe(0o600)
    // `wx` refuses to follow a symlink planted at the staging path and keeps a
    // concurrent writer out of this write's staging file.
    expect(staged?.flag).toBe('wx')
  })

  it('keeps the previous marker whole and removes the staging file when the write fails midway', async () => {
    const profile = await profileAwaitingRecovery()
    const marker = markerPath(profile)
    const before = await readFile(marker, 'utf8')
    recorder.truncateWriteInside = dirname(marker)

    // The recovery task swallows its own failure, so the marker on disk is the
    // whole assertion.
    await rewriteMarker(profile)

    // A direct write would have left the truncated half at the marker path; the
    // staging sibling is where it lands instead, and the failure removes it.
    expect(await readFile(marker, 'utf8')).toBe(before)
    expect(await stagingSiblings(profile)).toEqual([])
  })

  it('leaves no staging sibling behind after a successful rewrite', async () => {
    const profile = await profileAwaitingRecovery()

    await rewriteMarker(profile)

    expect(await stagingSiblings(profile)).toEqual([])
  })
})
