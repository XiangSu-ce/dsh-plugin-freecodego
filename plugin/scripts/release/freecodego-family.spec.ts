/** The FreeCodeGo release sequence: its single member, its tag, and its payload contract. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { officialClientBuildEnvironment, writeClientBuildRecord } from '../client-build-environment.ts'
import { releaseFamily, type ReleaseMember } from './families.ts'

const root = resolve(import.meta.dirname, '../..')

const bundleManifest = JSON.parse(
  readFileSync(join(root, 'packages/freecodego/bundle-latest/package.json'), 'utf8'),
) as { name: string; version: string }

/**
 * Every path the bundle's manifest resolves to, as a host loading it would see
 * them. Written out rather than derived, so a manifest that grows an entry the
 * bundle does not ship fails here instead of at publication.
 *
 * Only manifest-resolved paths belong here. `validatePayload` requires every
 * path the manifest declares to be present, and "declared" is exactly `exports`,
 * `main`, `dsh.bundle.patch` and `dsh.bootstrap.module`, so a row no manifest
 * names is inert: dropping it changes no verdict, and a build that stopped
 * writing the file it names would go unnoticed. The spec below asserts that
 * property row by row, and three rows that could never assert anything were
 * removed for it. `LICENSE` and `README.md` ship through the manifest's `files`
 * globs, which no half of `validatePayload` consults, and the Codex worker at
 * `dist/workers/codex-worker.js` is spawned by the bundle rather than resolved
 * by the manifest, so nothing here would have caught its absence either.
 *
 * No asset path appears here for the same reason: this list used to carry
 * `dist/assets/engineering/skills/index.md`, a file that has never existed in
 * this repository and that the packed payload does not contain.
 */
const bundlePayload = [
  'package.json',
  'cordis.patch.yml',
  'dist/bootstrap.js',
  'dist/client.cjs',
  'dist/session-events.js',
  'dist/agent-team.js',
  'dist/tool-agent-team.js',
  'dist/schedule.js',
  'dist/auto-review.js',
]

/**
 * A release member standing in for a manifest on disk.
 * @param directory - repository-relative package directory.
 * @param name - package name.
 * @param manifest - manifest fields the subject reads.
 * @returns The member.
 */
function member(directory: string, name: string, manifest: Record<string, unknown> = {}): ReleaseMember {
  return { directory, name, version: '0.0.1', manifest }
}

const roots: string[] = []

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/**
 * A repository root holding one complete client build of the given profile.
 * @param environment - public client environment the record carries.
 * @returns The fixture root.
 */
function buildFixture(environment: Record<string, string>): string {
  const fixture = mkdtempSync(join(tmpdir(), 'dsh-freecodego-build-'))
  roots.push(fixture)
  write(join(fixture, 'package.json'), `${JSON.stringify({ version: environment.DSH_CLIENT_VERSION ?? '0.0.1' })}\n`)
  write(join(fixture, 'apps/web/dist/index.html'), '<main></main>')
  write(join(fixture, 'packages/client/example/lib/client.js'), 'module.exports = {}\n')
  writeClientBuildRecord(fixture, environment)
  return fixture
}

afterEach(() => {
  for (const fixture of roots.splice(0)) rmSync(fixture, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('freecodego release family', () => {
  it('is the family the release workflow dispatches, and publishes the bundle alone', () => {
    const family = releaseFamily('freecodego')
    expect(family.members(root)).toEqual([
      {
        directory: 'packages/freecodego/bundle-latest',
        name: bundleManifest.name,
        version: bundleManifest.version,
        manifest: JSON.parse(
          readFileSync(join(root, 'packages/freecodego/bundle-latest/package.json'), 'utf8'),
        ) as Record<string, unknown>,
      },
    ])
  })

  it('publishes the extension libraries through the bundle rather than beside it', () => {
    const extension = releaseFamily('dsh').members(root)
      .filter(entry => entry.directory.startsWith('packages/freecodego/'))
    expect(extension).toEqual([])
  })

  it('names one tag for the whole family and publishes a prerelease under next', () => {
    const family = releaseFamily('freecodego')
    const bundle = member('packages/freecodego/bundle-latest', bundleManifest.name)
    expect(family.tagFor({ ...bundle, version: '0.1.6-alpha.1' })).toBe('freecodego-v0.1.6-alpha.1')
    expect(family.distTagForVersion('0.1.6-alpha.1')).toBe('next')
    expect(family.distTagForVersion('0.1.6')).toBeUndefined()
  })

  it('rejects a version this repository cannot publish, and members that disagree', () => {
    const family = releaseFamily('freecodego')
    const bundle = member('packages/freecodego/bundle-latest', bundleManifest.name)
    expect(() => { family.verifyVersions([bundle]) }).not.toThrow()
    expect(() => { family.verifyVersions([{ ...bundle, version: 'latest' }]) })
      .toThrow(/unpublishable version/)
    expect(() => {
      family.verifyVersions([
        bundle,
        { ...member('packages/freecodego/other', 'freecodego-other'), version: '0.0.2' },
      ])
    }).toThrow(/must share one version/)
  })

  it('accepts the bundle payload and reports an export the build did not write', () => {
    const family = releaseFamily('freecodego')
    const bundle = family.members(root)[0]!
    expect(() => { family.validatePayload(bundle, bundlePayload) }).not.toThrow()

    // The hazard this catches: the bundle's `cordis.patch.yml` mounts
    // `freecodego/schedule`, so a stale `dist/` silently drops the scheduler.
    const stale = bundlePayload.filter(path => path !== 'dist/schedule.js')
    expect(() => { family.validatePayload(bundle, stale) })
      .toThrow(/does not carry dist\/schedule\.js, which its manifest resolves to/)
  })

  it('names only paths the manifest resolves, so no snapshot row is inert', () => {
    // A snapshot row earns its place by failing when the payload drops it, which
    // is what the sibling test above demonstrates for `dist/schedule.js`. The
    // gate's declared set comes from the manifest, so a row no manifest names
    // cannot fail: it would sit in the list looking like coverage while the file
    // it names went unbuilt. Asking the gate itself, rather than re-deriving
    // which manifest fields it reads, keeps this true if `declaredPayloadPaths`
    // ever learns to read another one.
    const family = releaseFamily('freecodego')
    const bundle = family.members(root)[0]!
    const accepts = (files: readonly string[]): boolean => {
      try {
        family.validatePayload(bundle, files)
        return true
      } catch {
        return false
      }
    }
    const inert = bundlePayload.filter(row =>
      accepts(bundlePayload.filter(candidate => candidate !== row)))
    expect(inert).toStrictEqual([])
  })

  it('rejects a payload that publishes source, as every other family does', () => {
    const family = releaseFamily('freecodego')
    const bundle = family.members(root)[0]!
    expect(() => { family.validatePayload(bundle, [...bundlePayload, 'src/index.ts']) })
      .toThrow(/publishes source file/)
  })

  it('requires a current official client build and drives no executable', () => {
    const family = releaseFamily('freecodego')
    expect(family.installedEntry).toBeUndefined()
    const officialEnvironment = officialClientBuildEnvironment(root)
    vi.stubEnv('DSH_CLIENT_COMMIT_HASH', officialEnvironment.DSH_CLIENT_COMMIT_HASH)
    const built = buildFixture(officialEnvironment)
    expect(() => { family.verifyBuildArtifacts(built) }).not.toThrow()

    const defaultBuild = buildFixture({})
    expect(() => { family.verifyBuildArtifacts(defaultBuild) }).toThrow(/DSH_CLIENT_TITLE/)
    rmSync(join(built, '.dsh-build'), { recursive: true, force: true })
    expect(() => { family.verifyBuildArtifacts(built) }).toThrow(/record.*missing/)
  })

  it('skips a tree another family owns instead of publishing it', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'dsh-release-foreign-'))
    roots.push(fixture)
    write(join(fixture, 'packages/upstream/example/package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-example',
      version: '0.0.1',
    }))
    write(join(fixture, 'packages/freecodego/extension/package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-freecodego-extension',
      version: '0.0.1',
    }))
    expect(releaseFamily('dsh').members(fixture).map(entry => entry.name))
      .toEqual(['@deepseek-ai/dsh-example'])
  })

  it('fails a family whose matches are all foreign or private', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'dsh-release-empty-'))
    roots.push(fixture)
    write(join(fixture, 'packages/freecodego/extension/package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-freecodego-extension',
      version: '0.0.1',
    }))
    expect(() => { releaseFamily('dsh').members(fixture) })
      .toThrow(/release family dsh selected no publishable manifests/)
  })
})
