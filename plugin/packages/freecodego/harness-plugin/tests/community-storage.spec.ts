import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readCommunityInstallationLedger, writeCommunityInstallationLedger } from '../src/community-storage.ts'

const directories: string[] = []

afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

describe('community installation ledger', () => {
  it('keeps both entries when two sources are recorded concurrently', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-community-ledger-'))
    directories.push(directory)
    const file = join(directory, '.dsh-market', 'freecodego-community-installations.json')

    await Promise.all([
      writeCommunityInstallationLedger(file, 'https://example.test/first', ['first-package']),
      writeCommunityInstallationLedger(file, 'https://example.test/second', ['second-package']),
    ])

    await expect(readCommunityInstallationLedger(file)).resolves.toStrictEqual({
      version: 1,
      entries: {
        'https://example.test/first': ['first-package'],
        'https://example.test/second': ['second-package'],
      },
    })
  })
})
