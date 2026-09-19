/**
 * Two captures at once, and the blob they share.
 *
 * The blob store is content-addressed, so two captures that overlap in one
 * process — the model's `engineering_checkpoint_capture` while the throttled
 * pre-mutation auto capture is still writing, or two sessions doing both — hash
 * the same unchanged file to the same target and stage it to the same place. The
 * staging name and the commit are therefore a concurrency contract, not a naming
 * preference, and this spec is where both are asserted.
 *
 * The interleaving is forced rather than hoped for, and so is the platform
 * behaviour that makes the lost commit a failure: this file mocks
 * `node:fs/promises` so the first staged blob write is held until a second one
 * arrives (both writers therefore sit past `existsSync(target)` before either can
 * rename), and a rename whose destination already exists is refused with the
 * error Windows raises in exactly that case. `engineering-checkpoints.spec.ts`
 * reaches the module through named imports, so the default-export spy used
 * elsewhere would not reach the call sites; this module is mocked instead, with
 * every function delegating to the real one.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EngineeringCheckpointStore } from '../src/engineering-checkpoints.ts'

/** Paths a blob write stages at, in both the token and the pid naming. */
const STAGED_BLOB = /\.tmp(?:-|$)/u

const recorder = vi.hoisted(() => ({
  staged: [] as string[],
  renames: [] as Array<{ readonly from: string; readonly to: string }>,
  /** Commits that reached the destination first. */
  committed: 0,
  /** The commit that reached the destination first, for the next one to lose to. */
  pendingCommit: Promise.resolve(),
  /** Commits refused because the destination appeared while they were in flight. */
  refused: [] as string[],
  /** The first staged write, held until a second one arrives. */
  held: undefined as undefined | { readonly arrived: Promise<void>; readonly release: () => void },
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const writeFileActual = actual.writeFile as never as (target: unknown, content: unknown, options?: unknown) => Promise<void>
  const renameActual = actual.rename as never as (source: unknown, target: unknown) => Promise<void>
  return {
    ...actual,
    writeFile: async (file: unknown, data: unknown, options?: unknown) => {
      const path = String(file)
      if (!STAGED_BLOB.test(path)) return writeFileActual(file, data, options)
      recorder.staged.push(path)
      const held = recorder.held
      if (held === undefined) {
        let release!: () => void
        const arrived = new Promise<void>((resolve) => { release = resolve })
        recorder.held = { arrived, release }
        // The content is written before waiting: the point is to have both
        // writers' bytes on disk under their own names, which is what makes the
        // two `rename` calls contend for one destination.
        await writeFileActual(file, data, options)
        await arrived
        return
      }
      await writeFileActual(file, data, options)
      recorder.held = undefined
      held.release()
    },
    rename: async (from: unknown, to: unknown) => {
      const source = String(from)
      const target = String(to)
      recorder.renames.push({ from: source, to: target })
      if (STAGED_BLOB.test(source)) {
        // The first commit of one blob is allowed; every later one is refused,
        // which is how Windows behaves when the destination appeared while the
        // rename was in flight (EPERM/EEXIST) — intermittently, and only under
        // exactly this contention, which is why it is injected rather than waited
        // for. The slot is taken on entry rather than after the syscall, because
        // both writers reach the syscall before either has resolved.
        const first = recorder.committed === 0
        recorder.committed += 1
        if (!first) {
          // The refusal this models is the syscall finding the destination
          // already there, so the commit it lost to has to have landed first.
          await recorder.pendingCommit
          recorder.refused.push(source)
          throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
        }
        recorder.pendingCommit = renameActual(from, to)
        return recorder.pendingCommit
      }
      return renameActual(from, to)
    },
  }
})

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  recorder.staged.length = 0
  recorder.renames.length = 0
  recorder.committed = 0
  recorder.pendingCommit = Promise.resolve()
  recorder.refused.length = 0
  recorder.held = undefined
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** A workspace holding one file, and an opened store beside it. */
async function workspaceAndStore(): Promise<{ readonly workspace: string; readonly store: EngineeringCheckpointStore }> {
  const workspace = await mkdtemp(join(tmpdir(), 'freecodego-checkpoint-blob-ws-'))
  const storeDirectory = await mkdtemp(join(tmpdir(), 'freecodego-checkpoint-blob-store-'))
  roots.push(workspace, storeDirectory)
  await mkdir(join(workspace, 'src'), { recursive: true })
  await writeFile(join(workspace, 'src', 'app.ts'), 'export const app = 1\n', 'utf8')
  const store = new EngineeringCheckpointStore(storeDirectory)
  await store.open()
  return { workspace, store }
}

describe('a blob written by two captures at once', () => {
  it('keeps an entry for a capture whose commit lost to the other', async () => {
    // Mutation: renaming without tolerating a lost commit makes this case fail.
    // The refusal is swallowed by `capture`, which skips the file it cannot
    // stage, so the checkpoint lists the file as captured while holding no blob
    // for it — and a later restore leaves that file's post-checkpoint contents in
    // place while reporting success.
    const { workspace, store } = await workspaceAndStore()

    const [manual, auto] = await Promise.all([
      store.capture({ cwd: workspace, label: 'manual' }),
      store.capture({ cwd: workspace, label: 'auto: before edit' }),
    ])

    // The lost commit really happened, so this case cannot pass vacuously.
    expect(recorder.refused).toHaveLength(1)
    // Both checkpoints recorded the file they snapshotted...
    expect(manual.entries.map(entry => entry.file)).toEqual(['src/app.ts'])
    expect(auto.entries.map(entry => entry.file)).toEqual(['src/app.ts'])
    // ...and the blob the loser wanted to store is there for either to restore
    // from, because losing to a writer of the same hash means the bytes are
    // already in place.
    await writeFile(join(workspace, 'src', 'app.ts'), 'export const app = 999\n', 'utf8')
    await expect(store.restore({ cwd: workspace, id: auto.id })).resolves.toMatchObject({ restoredFiles: 1, missingBlobs: 0 })
    expect(await readFile(join(workspace, 'src', 'app.ts'), 'utf8')).toBe('export const app = 1\n')
    store.close()
  })

  it('gives each write its own staging path', async () => {
    // Mutation: staging as `${target}.tmp-${process.pid}` makes this case fail.
    // One path between two writers is a write and a rename interleaving through
    // one file, which is what the two renames below must not do.
    const { workspace, store } = await workspaceAndStore()

    await Promise.all([
      store.capture({ cwd: workspace, label: 'first' }),
      store.capture({ cwd: workspace, label: 'second' }),
    ])

    expect(recorder.staged).toHaveLength(2)
    expect(new Set(recorder.staged).size).toBe(2)
    store.close()
  })

  it('commits both writers to the one target that names their content', async () => {
    const { workspace, store } = await workspaceAndStore()

    await Promise.all([
      store.capture({ cwd: workspace, label: 'first' }),
      store.capture({ cwd: workspace, label: 'second' }),
    ])

    const commits = recorder.renames.filter(entry => STAGED_BLOB.test(entry.from))
    // Two staged names, one destination: a content-addressed store has one truth
    // per hash, and the loser of the race must land on it rather than beside it.
    expect(commits).toHaveLength(2)
    expect(new Set(commits.map(entry => entry.from)).size).toBe(2)
    expect(new Set(commits.map(entry => entry.to)).size).toBe(1)
    store.close()
  })
})
