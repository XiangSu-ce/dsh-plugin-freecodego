/**
 * An unreadable trust record is not an empty one.
 *
 * The gate reads this file at boot and answers every project-scoped question
 * from it, so the two ways a read can fail have to stay distinguishable. Absence
 * is a fact the store may act on — it is what a first launch looks like, and what
 * makes the first-sight seed safe — while a file that is *there* and that this
 * process could not read may hold grants it simply failed to see.
 *
 * Getting that wrong costs the record: an empty answer remembered from a failed
 * read is what the next `grant` builds its new record from, so the file is
 * rewritten holding only the repository just granted and every other one comes
 * back as `no-record` on the next launch — the reason a repository that was
 * never granted gets, with nothing on screen to say the grant existed.
 *
 * `src/trust.ts` reaches `node:fs/promises` through named imports, so the module
 * is mocked here (delegating to the real one) rather than spying on a default
 * export. One read is made to fail on demand, which is the only way to have a
 * file that fails once and answers afterwards.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalTrustKey, FolderTrustStore, TRUST_RECORD_VERSION } from '../src/trust.ts'

const recorder = vi.hoisted(() => ({
  /** Whether the next read of the record file fails as a locked file would. */
  failNextRecordRead: false,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const readFileActual = actual.readFile as never as (target: unknown, options?: unknown) => Promise<unknown>
  return {
    ...actual,
    readFile: async (target: unknown, options?: unknown) => {
      if (recorder.failNextRecordRead && String(target).endsWith('trusted-folders.json')) {
        recorder.failNextRecordRead = false
        // The shape a Windows lock takes (`EBUSY`), which `EACCES` matches
        // closely enough for the point: the file is there and this read could
        // not open it.
        throw Object.assign(new Error('EBUSY: resource busy or locked, open'), { code: 'EBUSY' })
      }
      return readFileActual(target, options)
    },
  }
})

describe('a trust record that could not be read', () => {
  let directory: string
  let file: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'freecodego-trust-unreadable-'))
    file = join(directory, 'nested', 'trusted-folders.json')
    recorder.failNextRecordRead = false
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    recorder.failNextRecordRead = false
    await rm(directory, { recursive: true, force: true })
  })

  it('is not remembered as an empty record, so the grants it holds survive the next write', async () => {
    await new FolderTrustStore(file).grant('/work/granted')

    // A second store is what a restart looks like, and its first read fails.
    const store = new FolderTrustStore(file)
    recorder.failNextRecordRead = true
    expect(await store.read()).toEqual({ version: TRUST_RECORD_VERSION, entries: [] })

    // Mutation: caching that answer leaves the grant invisible for the rest of
    // the process's life, and the grant below then rewrites the file from it.
    expect(await store.isTrusted(canonicalTrustKey('/work/granted'))).toBe(true)
    await store.grant('/work/other')

    const onDisk = JSON.parse(await readFile(file, 'utf8')) as { readonly entries: readonly { readonly root: string }[] }
    expect(onDisk.entries.map(entry => entry.root).sort()).toEqual([
      canonicalTrustKey('/work/granted'),
      canonicalTrustKey('/work/other'),
    ].sort())
  })

  it('refuses to rewrite a record it could not read, and leaves the file alone', async () => {
    // Present but not a record this build can account for. The read side keeps
    // its documented answer (an empty record, never a throw); the write side must
    // not act on it, because the file may hold grants a shallow parse did not
    // recover and the user's only copy of them is that file.
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, '{ not json', 'utf8')

    const store = new FolderTrustStore(file)
    expect(await store.read()).toEqual({ version: TRUST_RECORD_VERSION, entries: [] })
    await expect(store.grant('/work/repo')).rejects.toThrow(/could not be read/u)
    await expect(store.revoke('/work/repo')).rejects.toThrow(/could not be read/u)
    expect(await readFile(file, 'utf8')).toBe('{ not json')
  })

  it('grants normally when the read failed because there is no file at all', async () => {
    // Existence is the other half of the question: absence destroys nothing, so a
    // read that failed for any other reason must not be what stops a first grant.
    const store = new FolderTrustStore(file)
    recorder.failNextRecordRead = true
    expect(await store.read()).toEqual({ version: TRUST_RECORD_VERSION, entries: [] })
    await expect(store.grant('/work/repo')).resolves.toMatchObject({ version: TRUST_RECORD_VERSION })
    expect(await new FolderTrustStore(file).isTrusted(canonicalTrustKey('/work/repo'))).toBe(true)
  })
})
