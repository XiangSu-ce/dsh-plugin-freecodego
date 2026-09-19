import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp as realMkdtemp, rm, writeFile as realWriteFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { FreeCodeGoPluginUpdateService } from '../src/plugin-update.ts'

/**
 * State the mocked `node:fs/promises` layer reads.
 *
 * The service takes its recovery point with `mkdtemp` and writes its pending
 * marker with `writeFile`, and both of those are the only steps between
 * publishing `installing` and the package-manager run. Making them fail is the
 * only way to reach that window, and it is a real one: a read-only profile
 * directory, a full disk, or an antivirus lock all fail exactly here.
 */
const broken = { mkdtemp: false, marker: false }

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    mkdtemp: (...args: Parameters<typeof actual.mkdtemp>) => broken.mkdtemp
      ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
      : actual.mkdtemp(...args),
    writeFile: (...args: Parameters<typeof actual.writeFile>) => {
      const [target] = args
      // Matched as a substring, not a suffix: the marker is written atomically
      // through a `${file}.${randomUUID()}.tmp` staging path, so the marker's
      // name sits in the middle of the path rather than at its end. A suffix
      // test here would silently stop intercepting the write and the injected
      // EACCES would never fire — the failure this spec exists to catch.
      return broken.marker && typeof target === 'string' && target.includes('.dsh-freecodego-update-pending.json')
        ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
        : actual.writeFile(...args)
    },
  }
})

const HARNESS = '0.1.3-alpha.1'
const REPOSITORY = 'XiangSu-ce/dsh-freecodego'

function settings(enabled = true) {
  const value: Record<string, unknown> = { pluginUpdateChecksEnabled: enabled }
  return { get: () => value as { pluginUpdateChecksEnabled: boolean }, update: vi.fn(async () => undefined) }
}

function release(tag: string) {
  const version = tag.replace(/^v/, '')
  return {
    tag_name: tag,
    html_url: `https://github.com/${REPOSITORY}/releases/tag/${tag}`,
    published_at: '2026-09-13T00:00:00Z',
    assets: [{ name: `freecodego-${version}.tgz`, browser_download_url: `https://objects.githubusercontent.example/${tag}/bundle.tgz` }],
  }
}

async function releaseProfileFixture(): Promise<{ readonly profile: string; readonly dispose: () => Promise<void> }> {
  const root = await realMkdtemp(join(tmpdir(), 'freecodego-preflight-'))
  const profile = join(root, 'freecodego-latest')
  const write = async (relative: string, value: unknown): Promise<void> => {
    const target = join(profile, relative)
    await mkdir(dirname(target), { recursive: true })
    await realWriteFile(target, typeof value === 'string' ? value : JSON.stringify(value))
  }
  await write('package.json', { dependencies: { freecodego: HARNESS } })
  await write('pnpm-lock.yaml', `lockfileVersion: 9\npackages:\n  freecodego: ${HARNESS}\n`)
  await write(join('node_modules', '@deepseek-ai', 'dsh-base', 'package.json'), { version: HARNESS })
  await write(join('node_modules', 'freecodego', 'package.json'), { version: HARNESS, freecodego: { harnessBaseline: HARNESS } })
  return { profile, dispose: () => rm(root, { recursive: true, force: true }) }
}

afterEach(() => {
  broken.mkdtemp = false
  broken.marker = false
  vi.restoreAllMocks()
})

describe('a FreeCodeGo install that fails before the package manager runs', () => {
  it('reports the failure instead of leaving the card installing forever', async () => {
    const fixture = await releaseProfileFixture()
    try {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([release('v0.1.3-alpha.1.1')]), { status: 200 }))
      const runner = vi.fn(async () => ({ code: 0, detail: '' }))
      const service = new FreeCodeGoPluginUpdateService({ settings: settings() as never, profilePath: fixture.profile, runDsh: runner })
      await service.check(true)
      expect(service.status()).toMatchObject({ phase: 'available' })

      broken.mkdtemp = true
      await expect(service.install()).rejects.toThrow('EACCES')
      expect(runner).not.toHaveBeenCalled()
      // A phase of `installing` here is a spinner that never ends: nothing else
      // publishes a status until the next scheduled check, hours later.
      expect(service.status()).toMatchObject({ phase: 'error' })
      expect(service.status().error).toContain('EACCES')
    } finally {
      await fixture.dispose()
    }
  })

  it('reports the failure when the pending marker cannot be written', async () => {
    const fixture = await releaseProfileFixture()
    try {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([release('v0.1.3-alpha.1.1')]), { status: 200 }))
      const service = new FreeCodeGoPluginUpdateService({ settings: settings() as never, profilePath: fixture.profile, runDsh: async () => ({ code: 0, detail: '' }) })
      await service.check(true)

      broken.marker = true
      await expect(service.install()).rejects.toThrow('EACCES')
      expect(service.status()).toMatchObject({ phase: 'error' })
      expect(service.status().error).toContain('EACCES')
    } finally {
      await fixture.dispose()
    }
  })
})
