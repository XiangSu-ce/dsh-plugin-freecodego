import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { compareVersions, FreeCodeGoPluginUpdateService, windowsShimCommandLine } from '../src/plugin-update.ts'

const HARNESS = '0.1.3-alpha.1'
const REPOSITORY = 'XiangSu-ce/dsh-freecodego'

function settings(enabled = true) {
  // A stored `pluginUpdateChannel` from an earlier build is still present here
  // on purpose: the schema preserves unknown keys, and this service must ignore
  // the value rather than let it steer the check.
  let value: Record<string, unknown> = { pluginUpdateChecksEnabled: enabled, pluginUpdateChannel: 'next' }
  return { get: () => value as { pluginUpdateChecksEnabled: boolean }, update: vi.fn(async (next: typeof value) => { value = next }) }
}

/** One release as the GitHub API returns it, with a deliberately distinctive asset URL. */
function release(tag: string, options: { readonly assetName?: string; readonly assetUrl?: string; readonly draft?: boolean } = {}) {
  const version = tag.replace(/^v/, '')
  return {
    tag_name: tag,
    html_url: `https://github.com/${REPOSITORY}/releases/tag/${tag}`,
    published_at: '2026-09-13T00:00:00Z',
    ...(options.draft === true ? { draft: true } : {}),
    assets: [{
      name: options.assetName ?? `freecodego-${version}.tgz`,
      browser_download_url: options.assetUrl ?? `https://objects.githubusercontent.example/${tag}/bundle.tgz`,
    }],
  }
}

/**
 * Answer every release-source request with these releases.
 *
 * A fresh `Response` per call on purpose: a `Response` body can be read once,
 * and a check that runs after an earlier one would otherwise fail on a spent
 * body — an error that says nothing about the behaviour under test.
 */
function mockReleases(releases: readonly unknown[]): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response(JSON.stringify(releases), { status: 200 })))
}

afterEach(() => vi.restoreAllMocks())

/**
 * A profile installed from a release: the Harness line is detectable, the
 * installed bundle declares its baseline, and the dependency is a version
 * specifier rather than a local path.
 */
async function releaseProfileFixture(): Promise<{ readonly profile: string; readonly dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'freecodego-update-profile-'))
  const profile = join(root, 'freecodego-latest')
  const write = async (relative: string, value: unknown): Promise<void> => {
    const target = join(profile, relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, typeof value === 'string' ? value : JSON.stringify(value))
  }
  await write('package.json', { dependencies: { freecodego: HARNESS } })
  await write('pnpm-lock.yaml', `lockfileVersion: 9\npackages:\n  freecodego: ${HARNESS}\n`)
  await write(join('node_modules', '@deepseek-ai', 'dsh-base', 'package.json'), { version: HARNESS })
  await write(join('node_modules', 'freecodego', 'package.json'), { version: HARNESS, freecodego: { harnessBaseline: HARNESS } })
  return { profile, dispose: () => rm(root, { recursive: true, force: true }) }
}

/** Simulate what `dsh plugin add` does: place the requested version in the profile. */
async function installsVersion(profile: string, version: string): Promise<void> {
  const target = join(profile, 'node_modules', 'freecodego')
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'package.json'), JSON.stringify({ version, freecodego: { harnessBaseline: HARNESS } }))
}

describe('FreeCodeGo plugin updates from GitHub Releases', () => {
  it('offers the hotfix published for the running Harness line', async () => {
    const fixture = await releaseProfileFixture()
    try {
      mockReleases([release('v0.1.3-alpha.1.1'), release('v0.1.3-alpha.1')])
      const service = new FreeCodeGoPluginUpdateService({ settings: settings() as never, profilePath: fixture.profile })
      await expect(service.check(true)).resolves.toMatchObject({
        phase: 'available',
        latestVersion: '0.1.3-alpha.1.1',
        harnessVersion: HARNESS,
        harnessBaseline: HARNESS,
        installation: 'release',
        releaseRepository: REPOSITORY,
        releaseUrl: `https://github.com/${REPOSITORY}/releases/tag/v0.1.3-alpha.1.1`,
      })
    } finally {
      await fixture.dispose()
    }
  })

  it('reports being up to date when the running line has no newer release', async () => {
    const fixture = await releaseProfileFixture()
    try {
      mockReleases([release('v0.1.3-alpha.1')])
      const service = new FreeCodeGoPluginUpdateService({ settings: settings() as never, profilePath: fixture.profile })
      await expect(service.check(true)).resolves.toMatchObject({ phase: 'up-to-date', latestVersion: '0.1.3-alpha.1' })
    } finally {
      await fixture.dispose()
    }
  })

  it('offers nothing when every release is built for another Harness line', async () => {
    const fixture = await releaseProfileFixture()
    try {
      // Both are newer than what is installed, and both would resolve against
      // imports this Harness does not provide.
      mockReleases([release('v0.1.3-alpha.2'), release('v9.9.9')])
      const service = new FreeCodeGoPluginUpdateService({ settings: settings() as never, profilePath: fixture.profile })
      const status = await service.check(true)
      expect(status).toMatchObject({ phase: 'incompatible' })
      expect(status.latestVersion).toBeUndefined()
    } finally {
      await fixture.dispose()
    }
  })

  it('does not mistake a longer suffix for a hotfix of the running line', async () => {
    const fixture = await releaseProfileFixture()
    try {
      // `0.1.3-alpha.10` starts with the running line as a *string*, so only the
      // separator in the comparison keeps a different Harness line out.
      mockReleases([release('v0.1.3-alpha.10')])
      const service = new FreeCodeGoPluginUpdateService({ settings: settings() as never, profilePath: fixture.profile })
      await expect(service.check(true)).resolves.toMatchObject({ phase: 'incompatible' })
    } finally {
      await fixture.dispose()
    }
  })

  it('reads the configured repository and keeps its credential off the asset host', async () => {
    process.env.FREECODEGO_UPDATE_TEST_TOKEN = 'shh'
    try {
      const calls: Array<{ readonly url: string; readonly authorization: string | null }> = []
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        calls.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') })
        return new Response(JSON.stringify([release('v0.1.3-alpha.1.1')]), { status: 200 })
      })
      const service = new FreeCodeGoPluginUpdateService({
        settings: settings() as never,
        packageName: 'freecodego-test',
        releaseRepository: 'example/other-repo',
        releaseTokenEnv: 'FREECODEGO_UPDATE_TEST_TOKEN',
      })
      await service.check(true)
      expect(calls).toEqual([{
        url: 'https://api.github.com/repos/example/other-repo/releases?per_page=30',
        authorization: 'Bearer shh',
      }])
    } finally {
      delete process.env.FREECODEGO_UPDATE_TEST_TOKEN
    }
  })

  it('contains release-source failures in redacted update status rather than throwing during a check', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network unavailable'))
    const service = new FreeCodeGoPluginUpdateService({ settings: settings() as never, packageName: 'freecodego-test' })
    await expect(service.check(true)).resolves.toMatchObject({ phase: 'error', error: 'network unavailable' })
  })

  it('does not access the release source for disabled automatic checks while allowing a manual check', async () => {
    const fetchMock = mockReleases([release('v0.1.3-alpha.1.1')])
    const service = new FreeCodeGoPluginUpdateService({ settings: settings(false) as never, packageName: 'freecodego-test' })
    await service.check(false)
    expect(fetchMock).not.toHaveBeenCalled()
    await service.check(true)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('reports a local profile as local and never offers it a release', async () => {
    const fixture = await releaseProfileFixture()
    try {
      await writeFile(join(fixture.profile, 'package.json'), JSON.stringify({ dependencies: { freecodego: 'link:../../../packages/freecodego/bundle-latest' } }))
      const fetchMock = mockReleases([release('v0.1.3-alpha.1.1')])
      const service = new FreeCodeGoPluginUpdateService({ settings: settings() as never, profilePath: fixture.profile })
      await expect(service.check(true)).resolves.toMatchObject({ phase: 'up-to-date', installation: 'local' })
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      await fixture.dispose()
    }
  })

  it('installs through the dsh command with the release asset the check resolved', async () => {
    const fixture = await releaseProfileFixture()
    try {
      mockReleases([release('v0.1.3-alpha.1.1', { assetUrl: 'https://objects.githubusercontent.example/discovered.tgz' })])
      const runner = vi.fn(async (profile: string, args: readonly string[]) => {
        expect(profile).toBe('freecodego-latest')
        // The asset URL comes from the release document, not from a naming
        // convention rebuilt at install time.
        expect(args).toEqual(['add', '--save-exact', 'https://objects.githubusercontent.example/discovered.tgz'])
        await installsVersion(fixture.profile, '0.1.3-alpha.1.1')
        return { code: 0, detail: '' }
      })
      const service = new FreeCodeGoPluginUpdateService({ settings: settings() as never, profilePath: fixture.profile, runDsh: runner })
      await service.check(true)
      await expect(service.install()).resolves.toMatchObject({ phase: 'up-to-date', restartRequired: true, rollbackPending: true })
      expect(await readFile(join(fixture.profile, 'node_modules', 'freecodego', 'package.json'), 'utf8')).toContain('0.1.3-alpha.1.1')
      expect(runner).toHaveBeenCalledOnce()
      // A session started by the installing process proves the old bundle still
      // runs: it must not discard the recovery point that guards the restart.
      await expect(service.confirmStartup()).resolves.toMatchObject({ rollbackPending: true, restartRequired: true })
      // A restarted process running the target version confirms the update.
      const markerPath = join(fixture.profile, '.dsh-freecodego-update-pending.json')
      const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { processId: number }
      marker.processId += 1
      await writeFile(markerPath, `${JSON.stringify(marker)}\n`, 'utf8')
      await expect(service.confirmStartup()).resolves.toMatchObject({ rollbackPending: false, restartRequired: false })
      expect(existsSync(markerPath)).toBe(false)
    } finally {
      await fixture.dispose()
    }
  })

  it('stops offering the release it installed and keeps the restart prompt across the next check', async () => {
    const fixture = await releaseProfileFixture()
    try {
      mockReleases([release('v0.1.3-alpha.1.1')])
      const runner = vi.fn(async () => {
        await installsVersion(fixture.profile, '0.1.3-alpha.1.1')
        return { code: 0, detail: '' }
      })
      const service = new FreeCodeGoPluginUpdateService({ settings: settings() as never, profilePath: fixture.profile, runDsh: runner })
      await service.check(true)
      // The profile holds the version that was just installed, which is what the
      // check reads: the release is current now, and what remains is the restart.
      await expect(service.install()).resolves.toMatchObject({
        phase: 'up-to-date',
        currentVersion: '0.1.3-alpha.1.1',
        latestVersion: '0.1.3-alpha.1.1',
        restartRequired: true,
      })
      await expect(service.check(true)).resolves.toMatchObject({ phase: 'up-to-date', currentVersion: '0.1.3-alpha.1.1', restartRequired: true })
      // Installing again would re-run the package manager to place a version
      // that is already there, so the offer has to be gone.
      await expect(service.install()).rejects.toThrow('no newer FreeCodeGo version is available')
      expect(runner).toHaveBeenCalledOnce()
    } finally {
      await fixture.dispose()
    }
  })

  it('does not let a check that started before an install revoke the restart prompt', async () => {
    const fixture = await releaseProfileFixture()
    try {
      mockReleases([release('v0.1.3-alpha.1.1')])
      const service = new FreeCodeGoPluginUpdateService({
        settings: settings() as never,
        profilePath: fixture.profile,
        runDsh: async () => {
          await installsVersion(fixture.profile, '0.1.3-alpha.1.1')
          return { code: 0, detail: '' }
        },
      })
      await service.check(true)
      // The periodic check is still waiting on the release source while the user
      // installs; its answer describes the state before the install existed.
      let answerRelease: (() => void) | undefined
      vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((resolve) => {
        answerRelease = () => { resolve(new Response(JSON.stringify([release('v0.1.3-alpha.1.1')]), { status: 200 })) }
      }))
      const inFlight = service.check(true)
      await vi.waitFor(() => { expect(answerRelease).toBeDefined() })
      await service.install()
      if (answerRelease !== undefined) answerRelease()
      await inFlight
      expect(service.status()).toMatchObject({ phase: 'up-to-date', currentVersion: '0.1.3-alpha.1.1', restartRequired: true, rollbackPending: true })
    } finally {
      await fixture.dispose()
    }
  })

  it('keeps the install phase while a check resolves during it', async () => {
    const fixture = await releaseProfileFixture()
    try {
      mockReleases([release('v0.1.3-alpha.1.1')])
      let finishInstall: (() => void) | undefined
      const service = new FreeCodeGoPluginUpdateService({
        settings: settings() as never,
        profilePath: fixture.profile,
        runDsh: () => new Promise((resolve) => {
          finishInstall = () => {
            void installsVersion(fixture.profile, '0.1.3-alpha.1.1').then(() => { resolve({ code: 0, detail: '' }) })
          }
        }),
      })
      await service.check(true)
      const install = service.install()
      await vi.waitFor(() => { expect(service.status().phase).toBe('installing') })
      await service.check(true)
      expect(service.status()).toMatchObject({ phase: 'installing', restartRequired: false })
      if (finishInstall !== undefined) finishInstall()
      await expect(install).resolves.toMatchObject({ phase: 'up-to-date', restartRequired: true })
    } finally {
      await fixture.dispose()
    }
  })

  it('restores the manifests when the version that landed is not the one requested', async () => {
    const fixture = await releaseProfileFixture()
    try {
      mockReleases([release('v0.1.3-alpha.1.1')])
      const runner = vi.fn(async () => {
        // A command that reports success while resolving something else — a
        // proxy, a cache, or a replaced asset. Reporting success here would
        // leave the user on a build they did not ask for.
        await installsVersion(fixture.profile, '0.1.3-alpha.1.0')
        return { code: 0, detail: '' }
      })
      const service = new FreeCodeGoPluginUpdateService({ settings: settings() as never, profilePath: fixture.profile, runDsh: runner })
      await service.check(true)
      await expect(service.install()).rejects.toThrow('installed FreeCodeGo 0.1.3-alpha.1.0 instead of 0.1.3-alpha.1.1')
      expect(service.status()).toMatchObject({ phase: 'error', restartRequired: false })
      // The recovery point put the previous manifest back and is itself gone.
      expect(await readFile(join(fixture.profile, 'pnpm-lock.yaml'), 'utf8')).toContain('freecodego: 0.1.3-alpha.1')
      expect(existsSync(join(fixture.profile, '.dsh-freecodego-update-pending.json'))).toBe(false)
    } finally {
      await fixture.dispose()
    }
  })

  it('restores the manifests and reports the reason when the dsh command fails', async () => {
    const fixture = await releaseProfileFixture()
    try {
      mockReleases([release('v0.1.3-alpha.1.1')])
      const runner = vi.fn(async () => ({ code: 1, detail: 'ERR_PNPM_FETCH_404' }))
      const service = new FreeCodeGoPluginUpdateService({ settings: settings() as never, profilePath: fixture.profile, runDsh: runner })
      await service.check(true)
      await expect(service.install()).rejects.toThrow('ERR_PNPM_FETCH_404')
      expect(service.status()).toMatchObject({ phase: 'error', restartRequired: false })
      expect(await readFile(join(fixture.profile, 'package.json'), 'utf8')).toContain(HARNESS)
      expect(await readFile(join(fixture.profile, 'pnpm-lock.yaml'), 'utf8')).toContain('freecodego: 0.1.3-alpha.1')
      expect(existsSync(join(fixture.profile, '.dsh-freecodego-update-pending.json'))).toBe(false)
    } finally {
      await fixture.dispose()
    }
  })

  it('masks a credential the package manager echoes back in its refusal', async () => {
    // The install resolves a tarball URL, and the failure detail is stored in the
    // update status and shown until the next attempt, so a registry that refuses
    // the fetch and quotes the request — including the token a configured
    // registry carries in that URL — must not put it into that text.
    const fixture = await releaseProfileFixture()
    try {
      mockReleases([release('v0.1.3-alpha.1.1')])
      const leaked = `npm_${'A'.repeat(36)}`
      const runner = vi.fn(async () => ({ code: 1, detail: `ERR_PNPM_FETCH_401 GET https://registry.example.test/pkg?token=${leaked} - Unauthorized` }))
      const service = new FreeCodeGoPluginUpdateService({ settings: settings() as never, profilePath: fixture.profile, runDsh: runner })
      await service.check(true)
      const thrown = await service.install()
        .then(() => new Error('the install was expected to fail'), (error: unknown) => error instanceof Error ? error : new Error(String(error)))
      expect(thrown.message).toContain('ERR_PNPM_FETCH_401')
      expect(thrown.message).not.toContain(leaked)
      expect(service.status().error).not.toContain(leaked)
    } finally {
      await fixture.dispose()
    }
  })

  it('keeps the recovery marker and says so when the rollback itself fails', async () => {
    const fixture = await releaseProfileFixture()
    try {
      mockReleases([release('v0.1.3-alpha.1.1')])
      // The rollback copies `package.json` back first and `pnpm-lock.yaml`
      // second. A directory where the lock file belongs makes that second copy
      // fail *after* the first one landed — the half-restored profile this
      // branch exists for. Deleting the marker there would strand it: the
      // marker's own `promoting` branch is the only retry, and the orphan sweep
      // removes an unmarked recovery point an hour later.
      const lock = join(fixture.profile, 'pnpm-lock.yaml')
      const service = new FreeCodeGoPluginUpdateService({
        settings: settings() as never,
        profilePath: fixture.profile,
        runDsh: vi.fn(async () => {
          await installsVersion(fixture.profile, '0.1.3-alpha.1.1')
          await rm(lock, { force: true })
          await mkdir(lock, { recursive: true })
          return { code: 1, detail: 'ERR_PNPM_FETCH_404' }
        }),
      })
      await service.check(true)
      const thrown = await service.install().catch((error: unknown) => error)
      expect(thrown).toBeInstanceOf(Error)
      // Both halves are reported: the install failure, and the rollback that did
      // not finish — the part the user's next start depends on.
      expect((thrown as Error).message).toContain('ERR_PNPM_FETCH_404')
      expect((thrown as Error).message).toContain('could not be restored')
      expect(service.status().error).toContain('could not be restored')
      expect(existsSync(join(fixture.profile, '.dsh-freecodego-update-pending.json'))).toBe(true)
    } finally {
      await fixture.dispose()
    }
  })

  it('restores the previous manifests when startup finds a marker left mid-install', async () => {
    const fixture = await releaseProfileFixture()
    try {
      mockReleases([release('v0.1.3-alpha.1.1')])
      const runner = vi.fn(async () => {
        await installsVersion(fixture.profile, '0.1.3-alpha.1.1')
        return { code: 0, detail: '' }
      })
      const service = new FreeCodeGoPluginUpdateService({ settings: settings() as never, profilePath: fixture.profile, runDsh: runner })
      await service.check(true)
      await expect(service.install()).resolves.toMatchObject({ phase: 'up-to-date', rollbackPending: true })
      // A crash replaced the marker's success state with the in-flight one.
      const markerPath = join(fixture.profile, '.dsh-freecodego-update-pending.json')
      await writeFile(join(fixture.profile, 'package.json'), JSON.stringify({ dependencies: { freecodego: '0.1.3-alpha.1.1' } }))
      await writeFile(markerPath, `${JSON.stringify(JSON.parse(await readFile(markerPath, 'utf8')), (key, value) => key === 'promoting' ? true : value)}\n`, 'utf8')
      await expect(service.confirmStartup()).resolves.toMatchObject({ phase: 'error', restartRequired: true, rollbackPending: false })
      expect(await readFile(join(fixture.profile, 'package.json'), 'utf8')).toContain(HARNESS)
    } finally {
      await fixture.dispose()
    }
  })

  it('refuses a marker that names a bystander directory instead of a recovery point', async () => {
    const fixture = await releaseProfileFixture()
    try {
      // A local link keeps the check itself offline, so this case is only about
      // recovery. Right next to the profile is exactly where every other profile
      // lives, and restoring ends by deleting whatever the marker named — so
      // "inside the profile parent" cannot be the whole test.
      await writeFile(join(fixture.profile, 'package.json'), JSON.stringify({ dependencies: { freecodego: `link:${join('..', '..', 'packages', 'freecodego', 'bundle-latest')}` } }))
      const bystander = join(dirname(fixture.profile), 'important-user-data')
      await mkdir(bystander, { recursive: true })
      await writeFile(join(bystander, 'notes.txt'), 'do not delete')
      await writeFile(join(fixture.profile, '.dsh-freecodego-update-pending.json'), JSON.stringify({
        version: 1, packageName: 'freecodego', targetVersion: '9.9.9',
        backupDirectory: bystander, attempts: 1, processId: 999_999,
      }))

      const service = new FreeCodeGoPluginUpdateService({ settings: settings() as never, profilePath: fixture.profile })
      await service.check(true)

      await expect(readFile(join(bystander, 'notes.txt'), 'utf8')).resolves.toBe('do not delete')
      // The marker stays visible rather than the directory disappearing.
      expect(service.status().rollbackPending).toBe(true)
    } finally {
      await fixture.dispose()
    }
  })

  it('treats a truncated or empty pending marker as no pending update instead of failing construction', async () => {
    const fixture = await releaseProfileFixture()
    try {
      const markerPath = join(fixture.profile, '.dsh-freecodego-update-pending.json')
      mockReleases([])
      // The artifacts a non-atomic marker write leaves behind: an empty file when
      // the process dies before the first byte, and a half-written document when
      // it dies partway through. Reading a marker is a startup path, so neither
      // may take the Host down — a bare parse would throw here, and a crash in
      // the constructor bricks the update flow before anything can report it.
      for (const artifact of ['', '{"version":1,"packageName":"freecodego","targetVer']) {
        await writeFile(markerPath, artifact)
        const service = new FreeCodeGoPluginUpdateService({ settings: settings() as never, profilePath: fixture.profile })
        await service.check(true)
        expect(service.status().rollbackPending).toBeUndefined()
        expect(service.status().phase).not.toBe('error')
      }
    } finally {
      await fixture.dispose()
    }
  })

  // The sweep's decision is a comparison between `Date.now()` and a
  // directory's mtime, so every case below PINS the mtime with `utimes` instead
  // of relying on when the directory happened to be created. A directory made
  // "just now" is fresh on any idle machine; under parallel load that is
  // exactly the timing nothing guarantees.
  it('leaves a recovery directory that is still fresh alone', async () => {
    const fixture = await releaseProfileFixture()
    try {
      // An install running in another process keeps its recovery point younger
      // than the sweep's age limit; deleting it there would break that rollback.
      const other = join(dirname(fixture.profile), '.freecodego-latest-freecodego-backup-live')
      await mkdir(other, { recursive: true })
      const now = new Date()
      await utimes(other, now, now)
      // The sweep runs inside the service's recovery task, before any request,
      // so the release check is stubbed: a live GitHub call here made a pure
      // filesystem assertion depend on the network, and a slow response showed
      // up as this test timing out rather than failing.
      mockReleases([])
      const service = new FreeCodeGoPluginUpdateService({ settings: settings() as never, packageName: 'freecodego-test', profilePath: fixture.profile })
      await service.check(true)
      expect((await stat(other)).isDirectory()).toBe(true)
    } finally {
      await fixture.dispose()
    }
  })

  it('removes an orphaned recovery directory older than the age limit', async () => {
    const fixture = await releaseProfileFixture()
    try {
      // The destructive half of the same comparison, which the fresh case alone
      // cannot cover: a sweep that never deleted anything would pass that one.
      const orphan = join(dirname(fixture.profile), '.freecodego-latest-freecodego-backup-orphan')
      await mkdir(orphan, { recursive: true })
      const stale = new Date(Date.now() - 2 * 60 * 60 * 1_000)
      await utimes(orphan, stale, stale)
      mockReleases([])
      const service = new FreeCodeGoPluginUpdateService({ settings: settings() as never, packageName: 'freecodego-test', profilePath: fixture.profile })
      await service.check(true)
      await expect(stat(orphan)).rejects.toThrow(/ENOENT/u)
    } finally {
      await fixture.dispose()
    }
  })

  it('keeps the recovery point the marker names even when it is older than the age limit', async () => {
    const fixture = await releaseProfileFixture()
    try {
      // The age window is a heuristic for "nobody owns this"; the marker is
      // evidence. An install that has been retrying for more than an hour must
      // still be able to roll back, so the marker outranks the window.
      const owned = join(dirname(fixture.profile), '.freecodego-latest-freecodego-backup-owned')
      await mkdir(owned, { recursive: true })
      const stale = new Date(Date.now() - 2 * 60 * 60 * 1_000)
      await utimes(owned, stale, stale)
      mockReleases([])
      await writeFile(join(fixture.profile, '.dsh-freecodego-update-pending.json'), JSON.stringify({
        version: 1,
        packageName: 'freecodego-test',
        targetVersion: '9.9.9',
        backupDirectory: owned,
        attempts: 1,
        // Owned by THIS process: startup recovery is skipped (a marker naming
        // the running process belongs to nothing crashed), which leaves the
        // sweep as the only thing that could delete the directory. A foreign
        // pid would instead recover from that point and consume it, which is
        // correct behavior but tests a different path.
        processId: process.pid,
      }))
      const service = new FreeCodeGoPluginUpdateService({ settings: settings() as never, packageName: 'freecodego-test', profilePath: fixture.profile })
      await service.check(true)
      expect((await stat(owned)).isDirectory()).toBe(true)
    } finally {
      await fixture.dispose()
    }
  })

  it('keeps a percent-bearing asset URL out of the cmd.exe command line', () => {
    // Regression: `cmd.exe` expands `%NAME%` for any *defined* variable even
    // inside double quotes, so the one token here that carries publisher-chosen
    // text (the release asset URL) arrived as whatever that variable held. It is
    // handed over in the environment instead, where cmd substitutes it once and
    // never re-parses the result.
    const asset = 'https://objects.githubusercontent.example/%FCG_PROBE%.tgz'
    const shim = windowsShimCommandLine('dsh', ['plugin', '--profile', 'web', 'add', '--save-exact', asset])
    expect(shim.line).not.toContain('%FCG_PROBE%')
    const reference = /"%(FCG_DSH_ARG_\d+)%"/u.exec(shim.line)
    if (reference === null) throw new Error('the asset URL must be handed to the environment, not written into the line')
    const holder = reference[0]
    const variable = reference[1]
    if (variable === undefined) throw new Error('the environment reference must name its variable')
    expect(shim.environment[variable]).toBe(asset)
    // The line still has to be one verbatim command line for `cmd /d /s /c`.
    expect(shim.line.startsWith('"dsh plugin')).toBe(true)
    expect(shim.line).toContain(`"%${variable}%"`)
    expect(holder).toBe(`"%${variable}%"`)
  })

  it('leaves an ordinary install command line byte-for-byte unchanged', () => {
    const shim = windowsShimCommandLine('dsh', ['plugin', '--profile', 'web', 'add', '--save-exact', 'https://objects.githubusercontent.example/bundle.tgz'])
    expect(shim.line).toBe('"dsh plugin --profile web add --save-exact https://objects.githubusercontent.example/bundle.tgz"')
    expect(shim.environment).toEqual({})
    // Quoting still covers the characters cmd.exe would otherwise act on.
    expect(windowsShimCommandLine('dsh', ['plugin', '--profile', 'my profile']).line).toBe('"dsh plugin --profile \"my profile\""')
  })

  it('orders stable releases after prereleases', () => {
    expect(compareVersions('1.2.0', '1.2.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('1.2.0-rc.2', '1.2.0-rc.10')).toBeLessThan(0)
    expect(compareVersions('1.3.0', '1.2.9')).toBeGreaterThan(0)
    // The hotfix form: a further dotted segment sorts above the release it fixes.
    expect(compareVersions('0.1.3-alpha.1.1', '0.1.3-alpha.1')).toBeGreaterThan(0)
  })

  it('treats malformed versions as the lowest value', () => {
    expect(compareVersions('invalid', '0.0.1')).toBeLessThan(0)
    expect(compareVersions('invalid', 'invalid')).toBe(0)
  })
})
