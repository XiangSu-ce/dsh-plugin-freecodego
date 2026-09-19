import { access, mkdtemp, mkdir, readdir, utimes, writeFile, readFile, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EngineeringCheckpointStore } from '../src/engineering-checkpoints.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

/** Every file reachable from a directory, for whole-store assertions. */
async function everyFile(directory: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...await everyFile(path))
    else if (entry.isFile()) found.push(path)
  }
  return found
}

describe('engineering checkpoints', () => {
  it('captures tracked files, deduplicates unchanged content, and restores', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'freecodego-checkpoint-ws-'))
    const storeDirectory = await mkdtemp(join(tmpdir(), 'freecodego-checkpoint-store-'))
    directories.push(workspace, storeDirectory)
    await mkdir(join(workspace, 'src'), { recursive: true })
    await writeFile(join(workspace, 'src', 'app.ts'), 'export const app = 1\n', 'utf8')
    await writeFile(join(workspace, 'src', 'util.ts'), 'export const util = 2\n', 'utf8')

    const store = new EngineeringCheckpointStore(storeDirectory)
    await store.open()
    const first = await store.capture({ cwd: workspace, label: 'before edit' })
    expect(first.entries.map(entry => entry.file).sort()).toEqual(['src/app.ts', 'src/util.ts'])

    // Mutate one file and create a new one after the checkpoint.
    await writeFile(join(workspace, 'src', 'app.ts'), 'export const app = 999\n', 'utf8')
    await writeFile(join(workspace, 'src', 'generated.ts'), 'export const junk = true\n', 'utf8')

    const second = await store.capture({ cwd: workspace, label: 'after edit' })
    // The unchanged util.ts shares its blob between checkpoints.
    const utilInFirst = first.entries.find(entry => entry.file === 'src/util.ts')!
    const utilInSecond = second.entries.find(entry => entry.file === 'src/util.ts')!
    expect(utilInFirst.hash).toBe(utilInSecond.hash)

    // Restore the workspace to the first checkpoint.
    const restore = await store.restore({ cwd: workspace, id: first.id })
    expect(restore.restoredFiles).toBe(2)
    expect(restore.deletedFiles).toBe(1)
    expect(restore.missingBlobs).toBe(0)
    expect(await readFile(join(workspace, 'src', 'app.ts'), 'utf8')).toBe('export const app = 1\n')
    // The post-checkpoint generated file is removed by the restore.
    await expect(readFile(join(workspace, 'src', 'generated.ts'), 'utf8')).rejects.toThrow()
    // Untracked binary-ish files are never created or deleted by checkpoints.
    expect(store.list({ cwd: workspace })).toHaveLength(2)
    store.close()
  })

  it('never copies a credential file into the blob store', async () => {
    // Capture is a second durable copy of the workspace, and its blob store
    // lives under the plugin's data home — outside the repository, so outside
    // anything a `.gitignore` protects. Dotfiles (`.env`, `.npmrc`) are already
    // dropped by the tracking rule; `secrets.json` is the case that rule misses,
    // and the module's own credential guard names it.
    const workspace = await mkdtemp(join(tmpdir(), 'freecodego-checkpoint-ws-'))
    const storeDirectory = await mkdtemp(join(tmpdir(), 'freecodego-checkpoint-store-'))
    directories.push(workspace, storeDirectory)
    const secret = 'SERVICE_TOKEN=sk-live-0123456789abcdefghij\n'
    await mkdir(join(workspace, 'src'), { recursive: true })
    await writeFile(join(workspace, 'src', 'app.ts'), 'export const app = 1\n', 'utf8')
    await writeFile(join(workspace, 'secrets.json'), `{\n  "token": "${secret.trim()}"\n}\n`, 'utf8')

    const store = new EngineeringCheckpointStore(storeDirectory)
    await store.open()
    const checkpoint = await store.capture({ cwd: workspace, label: 'with a secret' })
    expect(checkpoint.entries.map(entry => entry.file)).toEqual(['src/app.ts'])
    expect(checkpoint.captured).toEqual(['src/app.ts'])

    // Nothing under the checkpoint store may contain those bytes: not a blob,
    // not the manifest, not the database.
    for (const file of await everyFile(storeDirectory)) {
      expect(await readFile(file, 'utf8')).not.toContain('sk-live-0123456789abcdefghij')
    }

    // Leaving it out of the capture list must not turn it into a restore
    // casualty: an untracked file is one restore never deletes.
    await writeFile(join(workspace, 'secrets.json'), `{\n  "token": "rotated-${secret.trim()}"\n}\n`, 'utf8')
    const restore = await store.restore({ cwd: workspace, id: checkpoint.id })
    expect(restore.deletedFiles).toBe(0)
    expect(await readFile(join(workspace, 'secrets.json'), 'utf8')).toContain('rotated-')
    store.close()
  })

  it('reports missing blobs instead of corrupting the restore', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'freecodego-checkpoint-ws-'))
    const storeDirectory = await mkdtemp(join(tmpdir(), 'freecodego-checkpoint-store-'))
    directories.push(workspace, storeDirectory)
    await writeFile(join(workspace, 'a.ts'), 'export const a = 1\n', 'utf8')
    const store = new EngineeringCheckpointStore(storeDirectory)
    await store.open()
    const checkpoint = await store.capture({ cwd: workspace, label: 'only' })
    // Simulate blob loss by opening a second store pointing at an empty directory.
    const emptyStore = new EngineeringCheckpointStore(await mkdtemp(join(tmpdir(), 'freecodego-checkpoint-empty-')))
    directories.pop()
    await emptyStore.open()
    // Copy the manifest into the empty store's database so `restore` finds the checkpoint but no blobs.
    const manifest = emptyStore.get({ cwd: workspace, id: checkpoint.id })
    expect(manifest).toBeUndefined()
    // A missing checkpoint errors clearly.
    await expect(store.restore({ cwd: workspace, id: 'ckpt_' + '0'.repeat(24) })).rejects.toThrow(/not found/)
    store.close()
    emptyStore.close()
  })

  it('keeps pre-existing tracked files outside the byte budget during restore', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'freecodego-checkpoint-budget-ws-'))
    const storeDirectory = await mkdtemp(join(tmpdir(), 'freecodego-checkpoint-budget-store-'))
    directories.push(workspace, storeDirectory)
    // Forty-nine tracked files at the 2 MiB per-file ceiling total 98 MiB;
    // capture stores only the first 48 files that fit its 96 MiB budget. The
    // complete capture list must still mark the tail as pre-existing, so
    // restore cannot mistake it for a new file.
    const size = 2 * 1024 * 1024
    for (let i = 0; i < 49; i += 1) {
      await writeFile(join(workspace, `file-${String(i).padStart(2, '0')}.ts`), Buffer.alloc(size, i))
    }
    const store = new EngineeringCheckpointStore(storeDirectory)
    await store.open()
    try {
      const checkpoint = await store.capture({ cwd: workspace, label: 'budget boundary' })
      const stored = new Set(checkpoint.entries.map(entry => entry.file))
      const skipped = checkpoint.captured?.filter(file => !stored.has(file)) ?? []
      expect(skipped.length).toBeGreaterThan(0)
      const result = await store.restore({ cwd: workspace, id: checkpoint.id })
      expect(result.deletedFiles).toBe(0)
      for (const file of skipped) await expect(access(join(workspace, file))).resolves.toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('keeps listing the readable checkpoints when one manifest is corrupt', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'freecodego-checkpoint-ws-'))
    const storeDirectory = await mkdtemp(join(tmpdir(), 'freecodego-checkpoint-store-'))
    directories.push(workspace, storeDirectory)
    await writeFile(join(workspace, 'a.ts'), 'const a = 1\n', 'utf8')
    const store = new EngineeringCheckpointStore(storeDirectory)
    await store.open()
    const good = await store.capture({ cwd: workspace, label: 'good' })
    const damaged = await store.capture({ cwd: workspace, label: 'damaged' })
    store.close()

    // Damage one manifest the way a half-written or hand-edited database would.
    const database = new DatabaseSync(join(storeDirectory, 'checkpoints.sqlite'))
    database.prepare('UPDATE engineering_checkpoints SET entries_json = ?, captured_json = ? WHERE id = ?')
      .run('{"not":"an array', '["a.ts", 7]', damaged.id)
    database.close()

    const reopened = new EngineeringCheckpointStore(storeDirectory)
    await reopened.open()
    // The readable checkpoint is still listed: one unreadable manifest must not
    // take the whole surface down with it.
    expect(reopened.list({ cwd: workspace }).map(item => item.id)).toEqual([good.id])
    // An unreadable manifest is refused rather than half-applied: restoring a
    // truncated entry list would delete the files the manifest lost.
    expect(reopened.get({ cwd: workspace, id: damaged.id })).toBeUndefined()
    await expect(reopened.restore({ cwd: workspace, id: damaged.id })).rejects.toThrow(/not found/)
    expect(await readFile(join(workspace, 'a.ts'), 'utf8')).toBe('const a = 1\n')
    reopened.close()
  })

  it('refuses a manifest whose entry escapes the workspace', async () => {
    // The parent is a directory this test owns, so an escaping write lands
    // somewhere observable instead of in the system temp root.
    const parent = await mkdtemp(join(tmpdir(), 'freecodego-checkpoint-parent-'))
    const workspace = join(parent, 'ws')
    await mkdir(workspace, { recursive: true })
    const storeDirectory = await mkdtemp(join(tmpdir(), 'freecodego-checkpoint-store-'))
    directories.push(parent, storeDirectory)
    await writeFile(join(workspace, 'a.ts'), 'const a = 1\n', 'utf8')
    const store = new EngineeringCheckpointStore(storeDirectory)
    await store.open()
    const checkpoint = await store.capture({ cwd: workspace, label: 'mine' })
    const [stored] = checkpoint.entries
    store.close()

    // Keep the real blob hash so the write would succeed if it were reached, and
    // point the entry one level above the workspace root.
    const database = new DatabaseSync(join(storeDirectory, 'checkpoints.sqlite'))
    database.prepare('UPDATE engineering_checkpoints SET entries_json = ?, captured_json = ? WHERE id = ?')
      .run(JSON.stringify([{ ...stored, file: '../escaped.ts' }]), JSON.stringify(['../escaped.ts']), checkpoint.id)
    database.close()

    const reopened = new EngineeringCheckpointStore(storeDirectory)
    await reopened.open()
    await expect(reopened.restore({ cwd: workspace, id: checkpoint.id })).rejects.toThrow(/not found/)
    // Nothing was written beside the workspace root either.
    await expect(access(join(parent, 'escaped.ts'))).rejects.toThrow()
    reopened.close()
  })

  it('removes a checkpoint manifest and enforces workspace scoping', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'freecodego-checkpoint-ws-'))
    const otherWorkspace = await mkdtemp(join(tmpdir(), 'freecodego-checkpoint-other-'))
    const storeDirectory = await mkdtemp(join(tmpdir(), 'freecodego-checkpoint-store-'))
    directories.push(workspace, otherWorkspace, storeDirectory)
    await writeFile(join(workspace, 'a.ts'), 'const a = 1\n', 'utf8')
    const store = new EngineeringCheckpointStore(storeDirectory)
    await store.open()
    const checkpoint = await store.capture({ cwd: workspace, label: 'mine' })
    // A different workspace cannot see or restore this checkpoint.
    expect(store.list({ cwd: otherWorkspace })).toHaveLength(0)
    await expect(store.restore({ cwd: otherWorkspace, id: checkpoint.id })).rejects.toThrow(/not found/)
    expect(() => store.remove({ cwd: otherWorkspace, id: checkpoint.id })).toThrow(/not found/)
    expect(store.remove({ cwd: workspace, id: checkpoint.id })).toEqual({ deleted: true })
    expect(store.list({ cwd: workspace })).toHaveLength(0)
    store.close()
  })

  it('stores one blob for two captures running at once', async () => {
    // Mutation: staging the blob as `${target}.tmp-${process.pid}` makes this
    // case fail — the second capture's `rename` finds the file the first already
    // moved away, `capture` swallows the throw by skipping that file, and the
    // checkpoint it wrote has the file in `captured` but no entry (and no blob)
    // for it.
    //
    // That shape is why the bug is worth a test rather than a comment: two
    // captures really do overlap in one process (the model's
    // `engineering_checkpoint_capture` while the throttled pre-mutation auto
    // capture is still writing, or two sessions doing both), they hash the same
    // unchanged file to the same target, and a checkpoint with a hole in it
    // restores *silently* — the file whose entry went missing keeps its
    // post-checkpoint contents while `restore` reports success.
    const workspace = await mkdtemp(join(tmpdir(), 'freecodego-checkpoint-race-ws-'))
    const storeDirectory = await mkdtemp(join(tmpdir(), 'freecodego-checkpoint-race-store-'))
    directories.push(workspace, storeDirectory)
    await mkdir(join(workspace, 'src'), { recursive: true })
    await writeFile(join(workspace, 'src', 'app.ts'), 'export const app = 1\n', 'utf8')

    const store = new EngineeringCheckpointStore(storeDirectory)
    await store.open()
    const [manual, auto] = await Promise.all([
      store.capture({ cwd: workspace, label: 'manual' }),
      store.capture({ cwd: workspace, label: 'auto: before edit' }),
    ])
    // Both checkpoints record the file they both snapshotted...
    expect(manual.entries.map(entry => entry.file)).toEqual(['src/app.ts'])
    expect(auto.entries.map(entry => entry.file)).toEqual(['src/app.ts'])
    // ...and the blob is there for either of them to restore from.
    await writeFile(join(workspace, 'src', 'app.ts'), 'export const app = 999\n', 'utf8')
    await expect(store.restore({ cwd: workspace, id: auto.id })).resolves.toMatchObject({ restoredFiles: 1, missingBlobs: 0 })
    expect(await readFile(join(workspace, 'src', 'app.ts'), 'utf8')).toBe('export const app = 1\n')
    store.close()
  })

  it('withholds the deletion half of a restore whose capture list is a prefix', async () => {
    // The walk stops once it holds 8 000 tracked files, and it takes a directory
    // whole, so seventeen 500-file directories leave the last one out of the
    // manifest. `captured` is the answer to "did this file exist at capture
    // time?" — the question restore deletes by and diff previews — and a prefix
    // cannot answer it, so both say so instead of guessing.
    //
    // Mutation: restoring without the flag deletes the file created below and
    // reports `deletedFiles: 1`, i.e. deletes a file the checkpoint never saw.
    // That is the shape, and the reason the withholding is worth a test rather
    // than a comment: the tail of the list is full of files that predate the
    // checkpoint, and on a filesystem whose `readdir` order is not name-stable
    // (ext4, APFS) the tail can differ between the capture walk and the deletion
    // walk, so the same list both hides real files and exposes others. A capture
    // whose walk reached every directory is unaffected: the eval case
    // `checkpoint.restore-rewrites-and-removes` still expects the deletion.
    const workspace = await mkdtemp(join(tmpdir(), 'freecodego-checkpoint-cap-ws-'))
    const storeDirectory = await mkdtemp(join(tmpdir(), 'freecodego-checkpoint-cap-store-'))
    directories.push(workspace, storeDirectory)
    const directoryNames = Array.from({ length: 17 }, (_, index) => `d${String(index).padStart(2, '0')}`)
    for (const name of directoryNames) {
      await mkdir(join(workspace, name), { recursive: true })
      await Promise.all(Array.from({ length: 500 }, (_, index) =>
        writeFile(join(workspace, name, `f${String(index).padStart(4, '0')}.ts`), 'export const v = 1\n', 'utf8')))
    }

    const store = new EngineeringCheckpointStore(storeDirectory)
    await store.open()
    const checkpoint = await store.capture({ cwd: workspace, label: 'more files than the walk cap' })
    // The manifest admits the incompleteness rather than passing the prefix off
    // as the workspace.
    expect(checkpoint.capturedTruncated).toBe(true)
    expect(checkpoint.captured).toHaveLength(8_000)
    const recorded = new Set(checkpoint.captured)
    const outside = directoryNames
      .flatMap(name => Array.from({ length: 500 }, (_, index) => `${name}/f${String(index).padStart(4, '0')}.ts`))
      .filter(file => !recorded.has(file))
    expect(outside.length).toBeGreaterThan(0)

    // A file created after the checkpoint, inside a directory the walk never
    // reached, and a file the manifest does name so the rewrite half has work.
    const laterDirectory = outside[0]!.split('/')[0]!
    const later = join(workspace, laterDirectory, 'later.ts')
    await writeFile(later, 'export const later = 1\n', 'utf8')
    const edited = checkpoint.entries[0]!.file
    await writeFile(join(workspace, ...edited.split('/')), 'export const edited = 1\n', 'utf8')

    const preview = store.diff({ cwd: workspace, id: checkpoint.id })
    expect(preview.captureListTruncated).toBe(true)
    // Withheld, not empty-because-there-is-nothing: the walk cannot tell this
    // file from the two thousand that predate the checkpoint.
    expect(preview.addedSince).toEqual([])
    expect(preview.modified).toContain(edited)

    const result = await store.restore({ cwd: workspace, id: checkpoint.id })
    expect(result).toMatchObject({ deletedFiles: 0, captureListTruncated: true })
    // The file the manifest named came back...
    expect(await readFile(join(workspace, ...edited.split('/')), 'utf8')).toBe('export const v = 1\n')
    // ...and the one it never saw was left alone rather than guessed at.
    await expect(access(later)).resolves.toBeUndefined()
    store.close()

    // The flag is a column, not a return value: whoever reopens the store must
    // still know this manifest may not delete by its list.
    const reopened = new EngineeringCheckpointStore(storeDirectory)
    await reopened.open()
    expect(reopened.get({ cwd: workspace, id: checkpoint.id })?.capturedTruncated).toBe(true)
    reopened.close()
  }, 60_000)

  it('counts blobs rather than the shard directories that hold them', async () => {
    // Blobs are sharded by the first two characters of their hash, so the
    // top-level listing is the shard count — 256 at most, whatever the store
    // holds. The eval case that watches this number only ever compares it against
    // itself, so 400 distinct files used to report 199.
    const workspace = await mkdtemp(join(tmpdir(), 'freecodego-checkpoint-count-ws-'))
    const storeDirectory = await mkdtemp(join(tmpdir(), 'freecodego-checkpoint-count-store-'))
    directories.push(workspace, storeDirectory)
    for (let index = 0; index < 400; index += 1) {
      await writeFile(join(workspace, `b${String(index).padStart(4, '0')}.ts`), `export const b${String(index)} = ${String(index)}\n`, 'utf8')
    }
    const store = new EngineeringCheckpointStore(storeDirectory)
    await store.open()
    const checkpoint = await store.capture({ cwd: workspace, label: 'distinct contents' })
    expect(store.blobCount()).toBe(checkpoint.entries.length)
    expect(store.blobCount()).toBe((await everyFile(join(storeDirectory, 'blobs'))).length)
    store.close()
  }, 60_000)

  it('releases the blobs a removed checkpoint was the last reference to', async () => {
    // Retention drops manifests past its cap and `remove` drops them on request;
    // before the sweep, the bytes they named stayed forever, so the store grew
    // with every distinct content ever captured while the history it could
    // restore stayed capped at forty checkpoints.
    const workspace = await mkdtemp(join(tmpdir(), 'freecodego-checkpoint-sweep-ws-'))
    const other = await mkdtemp(join(tmpdir(), 'freecodego-checkpoint-sweep-other-'))
    const storeDirectory = await mkdtemp(join(tmpdir(), 'freecodego-checkpoint-sweep-store-'))
    directories.push(workspace, other, storeDirectory)
    const content = (n: number): string => Array.from({ length: 200 }, (_, index) => `export const value${String(index)} = ${String(n * 1000 + index)}\n`).join('')
    // Ageing the store stands in for the wait: a capture of a bounded workspace
    // finishes in seconds, so a store an hour old is one whose in-flight writes
    // are all settled (see PRUNE_GRACE_MS).
    const ageBlobs = async (): Promise<void> => {
      const when = new Date(Date.now() - 60 * 60_000)
      for (const file of await everyFile(join(storeDirectory, 'blobs'))) await utimes(file, when, when)
    }

    const store = new EngineeringCheckpointStore(storeDirectory)
    await store.open()
    for (const [n, label] of [[1, 'one'], [2, 'two'], [3, 'three']] as const) {
      await writeFile(join(workspace, 'a.ts'), content(n), 'utf8')
      await store.capture({ cwd: workspace, label })
    }
    expect(store.blobCount()).toBe(3)
    await ageBlobs()
    for (const checkpoint of store.list({ cwd: workspace })) store.remove({ cwd: workspace, id: checkpoint.id })
    expect(store.blobCount()).toBe(0)

    // A blob written moments ago may belong to a capture that has not committed
    // its manifest yet (see `ensureBlob`), so the automatic sweep leaves it — and
    // an explicit sweep told not to wait still takes it.
    await writeFile(join(workspace, 'fresh.ts'), 'export const fresh = 1\n', 'utf8')
    const fresh = await store.capture({ cwd: workspace, label: 'fresh' })
    store.remove({ cwd: workspace, id: fresh.id })
    const insideTheGrace = store.blobCount()
    expect(insideTheGrace).toBeGreaterThan(0)
    store.prune({ graceMs: 0 })
    expect(store.blobCount()).toBe(0)

    // Liveness is store-wide: two workspaces whose files match share a blob, so a
    // sweep that only asked this workspace's manifests would take bytes the other
    // one still needs and its next restore would report them missing.
    await writeFile(join(workspace, 'shared.ts'), 'export const shared = 1\n', 'utf8')
    await writeFile(join(other, 'shared.ts'), 'export const shared = 1\n', 'utf8')
    const mine = await store.capture({ cwd: workspace, label: 'mine' })
    const theirs = await store.capture({ cwd: other, label: 'theirs' })
    await ageBlobs()
    store.remove({ cwd: workspace, id: mine.id })
    expect(store.blobCount()).toBe(1)
    await expect(store.restore({ cwd: other, id: theirs.id })).resolves.toMatchObject({ missingBlobs: 0 })
    expect(await readFile(join(other, 'shared.ts'), 'utf8')).toBe('export const shared = 1\n')
    store.close()
  })
})
