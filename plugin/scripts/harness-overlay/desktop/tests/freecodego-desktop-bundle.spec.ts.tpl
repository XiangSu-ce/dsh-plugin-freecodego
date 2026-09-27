/**
 * The FreeCodeGo Desktop forks need coverage that survives `sync:harness`.
 *
 * Why this spec lives outside `apps/desktop/tests/`
 * ------------------------------------------------
 * `sync-harness.mjs` mirrors `apps/` wholesale, `tests/` included, so a spec
 * written next to the code it covers is deleted by the next sync. This file is
 * kept as a `.tpl` under `scripts/harness-overlay/` and copied back on every
 * run -- the same pattern the timeout, approval and binary-document seams use.
 *
 * What it covers, and why it was uncovered
 * ----------------------------------------
 * Two of the three desktop forks are gated on an environment variable that the
 * shipping pipeline leaves unset: `FREECODEGO_DESKTOP_TARBALL` (the freshly
 * built bundle joins the local package set) and `FREECODEGO_DESKTOP_ELECTRON_VERSION`
 * (the packaging shell is pinned). An unset variable makes the fork inert, which
 * is precisely why upstream's own specs could not tell a working fork from a
 * broken one -- they never set it. The profile fork is not gated at all: the
 * Desktop runtime ships the bundle inside the signed application, so every
 * profile must activate it, on first creation and on every release after.
 *
 * `apps/desktop/tests/prepare-package-set.spec.ts` exercises
 * `selectDesktopPackageClosure` alone and never calls `prepareDesktopPackageSet`,
 * so the injected block had no caller anywhere in the suite.
 *
 * @module apps/desktop/tests/freecodego-desktop-bundle
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import { afterEach, describe, expect, it } from 'vitest'
import { DESKTOP_PACKAGE_SET_FILE, parseDesktopCorePackageSet } from '../src/core-package-set.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { DesktopProjectManager, createPluginProfile } from '../src/project-manager.ts'
import { prepareDesktopPackageSet } from '../scripts/prepare-package-set.ts'
import { runtimeFixture } from './runtime-fixture.ts'

const DSH_PACKAGE = '@deepseek-ai/dsh'
const HOST_PACKAGE = '@deepseek-ai/dsh-desktop-host'
const BUNDLE_PACKAGE = 'freecodego'
const BUNDLE_VARIABLE = 'FREECODEGO_DESKTOP_TARBALL'

/** The bundles the web template alone activates; the fork appends the app-owned bundle to these. */
const WEB_BUNDLES = (PROFILE_TEMPLATES.web as { readonly bundles: readonly string[] }).bundles

const roots: string[] = []
function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

afterEach(() => {
  // A literal key: `delete` on a computed one is what the lint budget refuses.
  delete process.env['FREECODEGO_DESKTOP_TARBALL']
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * `tar` reads a Windows drive letter as a remote host without this flag, which is
 * why the release helpers pass it too. Kept local so the fixture does not depend
 * on a release module's internal default.
 */
const TAR_PLATFORM_ARGS = process.platform === 'win32' ? ['--force-local'] : []

// `prepare-package-set.ts` reads a packed tarball with a bare `tar -xOzf <absolute path>`,
// while its sibling in `scripts/release/tarball.ts` adds `--force-local` on Windows. GNU tar
// reads `C:\...` as a remote host, so the package set cannot be prepared on Windows at all --
// measured, not inferred. This suite is about the fork's selection, not that upstream gap, so
// the flag is supplied through the environment the child inherits. Linux CI needs nothing.
if (process.platform === 'win32') {
  process.env['TAR_OPTIONS'] = [process.env['TAR_OPTIONS'], '--force-local'].filter(Boolean).join(' ')
}

/**
 * Pack a minimal npm tarball, so the selection reads a real archive rather than a stub.
 * @param directory - where the `.tgz` is written.
 * @param name - the file stem, also used for the staging directory.
 * @param manifest - manifest fields beyond the default `version`.
 * @param files - extra `package/` entries the closure walk requires.
 * @returns the tarball's absolute path.
 */
function packTarball(
  directory: string,
  name: string,
  manifest: Record<string, unknown>,
  files: Readonly<Record<string, string>> = {},
): string {
  const stage = join(directory, `stage-${name}`)
  mkdirSync(join(stage, 'package'), { recursive: true })
  writeFileSync(join(stage, 'package/package.json'), `${JSON.stringify({ version: '1.0.0', ...manifest }, undefined, 2)}\n`)
  for (const [path, body] of Object.entries(files)) {
    const target = join(stage, 'package', path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body)
  }
  const tarball = join(directory, `${name}.tgz`)
  execFileSync('tar', [...TAR_PLATFORM_ARGS, '-czf', tarball, '-C', stage, 'package'], { stdio: 'pipe' })
  return tarball
}

interface PackageSetFixture {
  readonly inputs: string
  readonly output: string
  readonly bundle: string
}

/**
 * A package set whose closure is exactly dsh plus its private Host.
 * @param options - `bundled` also puts the bundle in the closure, so the fork
 *   meets it there; the shipping pipeline never produces that shape, which is
 *   why the duplicate guard exists.
 * @returns the fixture's input directory, output path, and bundle tarball.
 */
function packageSetFixture(options: { readonly bundled?: boolean } = {}): PackageSetFixture {
  const root = temporaryRoot('dsh-desktop-freecodego-')
  const inputs = join(root, 'inputs')
  mkdirSync(inputs, { recursive: true })
  packTarball(inputs, 'dsh', {
    name: DSH_PACKAGE,
    ...(options.bundled === true ? { dependencies: { [BUNDLE_PACKAGE]: '1.0.0' } } : {}),
  })
  packTarball(inputs, 'desktop-host', { name: HOST_PACKAGE, dependencies: { [DSH_PACKAGE]: '^1.0.0' } }, {
    'lib/index.js': 'module.exports = {}\n',
  })
  // Outside the input directory by default: the closure walk cannot reach it.
  const bundle = options.bundled === true
    ? packTarball(inputs, BUNDLE_PACKAGE, { name: BUNDLE_PACKAGE })
    : packTarball(root, BUNDLE_PACKAGE, { name: BUNDLE_PACKAGE })
  return { inputs, output: join(root, 'out'), bundle }
}

/** The names a prepared package set declares, in the order it writes them. */
function selectedNames(output: string): string[] {
  const set = parseDesktopCorePackageSet(JSON.parse(readFileSync(join(output, DESKTOP_PACKAGE_SET_FILE), 'utf8')))
  return set.packages.map(entry => entry.name)
}

describe('desktop package set with a pinned FreeCodeGo tarball', () => {
  it('selects exactly the upstream closure when the variable is unset', () => {
    const { inputs, output } = packageSetFixture()
    prepareDesktopPackageSet([inputs], output)
    expect(selectedNames(output)).toEqual([DSH_PACKAGE, HOST_PACKAGE])
  })

  it('joins the bundle, in name order, when the variable names it', () => {
    const { inputs, output, bundle } = packageSetFixture()
    process.env[BUNDLE_VARIABLE] = bundle
    prepareDesktopPackageSet([inputs], output)
    // Sorted by name: '@' precedes 'f', so the bundle is appended last.
    expect(selectedNames(output)).toEqual([DSH_PACKAGE, HOST_PACKAGE, BUNDLE_PACKAGE])
  })

  it('refuses a tarball that is not the bundle', () => {
    const { inputs, output } = packageSetFixture()
    process.env[BUNDLE_VARIABLE] = join(inputs, 'dsh.tgz')
    expect(() => {
      prepareDesktopPackageSet([inputs], output)
    }).toThrow(/expected freecodego/u)
  })

  it('refuses the bundle a second time when the closure already carries it', () => {
    const { inputs, output, bundle } = packageSetFixture({ bundled: true })
    process.env[BUNDLE_VARIABLE] = bundle
    expect(() => {
      prepareDesktopPackageSet([inputs], output)
    }).toThrow(/duplicate packed package freecodego/u)
  })

  it('leaves a closure that already carries the bundle alone when the variable is unset', () => {
    const { inputs, output } = packageSetFixture({ bundled: true })
    prepareDesktopPackageSet([inputs], output)
    expect(selectedNames(output)).toEqual([DSH_PACKAGE, HOST_PACKAGE, BUNDLE_PACKAGE])
  })
})

/** A manager over a throwaway runtime, so `applyRelease` has a descriptor to read. */
function desktopManager(): DesktopProjectManager {
  const root = temporaryRoot('dsh-desktop-freecodego-manager-')
  const dsh = join(root, 'resources', 'dsh')
  runtimeFixture(dsh)
  return new DesktopProjectManager(resolveDesktopPaths(join(root, '.dsh')), { dsh })
}

/** The bundles a profile's manifest activates. */
function profileBundles(profile: string): string[] {
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
    readonly dsh: { readonly profile: { readonly bundles: string[] } }
  }
  return manifest.dsh.profile.bundles
}

describe('desktop profile bundles', () => {
  it('activates the built-in FreeCodeGo bundle when a profile is created', () => {
    const profile = join(temporaryRoot('dsh-desktop-freecodego-profile-'), 'profile')
    createPluginProfile(profile)
    // The web template's own bundles are kept and the app-owned one appended.
    expect(profileBundles(profile)).toEqual([...WEB_BUNDLES, BUNDLE_PACKAGE])
  })

  it('re-adds the bundle to a profile that predates this fork', async () => {
    const manager = desktopManager()
    await manager.applyRelease()
    const path = join(manager.paths.profile, 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    // An older build left the profile without the bundle; `initProfile` never rewrites an existing manifest.
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== BUNDLE_PACKAGE)
    writeFileSync(path, JSON.stringify(manifest))
    await manager.applyRelease()
    expect(profileBundles(manager.paths.profile)).toContain(BUNDLE_PACKAGE)
  })

  it('keeps the app-owned bundle when every third-party plugin is disabled', async () => {
    const manager = desktopManager()
    await manager.applyRelease()
    await manager.disableAllPlugins()
    expect(profileBundles(manager.paths.profile)).toContain(BUNDLE_PACKAGE)
  })
})
