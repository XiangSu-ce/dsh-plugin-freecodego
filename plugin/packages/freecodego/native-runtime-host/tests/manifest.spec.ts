/**
 * The runtime manifest validator is the only gate between a downloaded artifact
 * and an executable the plugin will spawn, and it had no test of its own: the
 * suites around it exercised the managers that call it, never the refusals.
 *
 * Two properties are pinned here. The platform mapping must refuse an
 * architecture no artifact was published for instead of folding it into `x64`
 * (an x64 binary selected for an incompatible machine installs cleanly, verifies
 * its digest, and only then fails inside the worker). And both path fields must
 * stay inside the artifact root — checked on the *normalized* form, so a path
 * that merely contains `..` while resolving inside is still accepted.
 *
 * @module @deepseek-ai/dsh-freecodego-native-runtime-host/tests/manifest
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { arch, platform } from 'node:process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  currentRuntimePlatform,
  runtimePlatformFor,
  validateRuntimeManifest,
  verifyRuntimeArtifact,
  type NativeRuntimeManifest,
} from '../src/manifest.ts'

/** A manifest that passes every field check, to be broken one field at a time. */
function validManifest(): Record<string, unknown> {
  return {
    manifestVersion: 1,
    engine: 'codex',
    platform: 'win32-x64',
    protocolAbi: 'freecodego-agent/1',
    runtimeAbi: 'codex/1.0.0',
    artifactPath: 'artifacts/windows-x64/package/codex.exe',
    args: ['app-server'],
    artifactDigest: `sha256:${'a'.repeat(64)}`,
    sourceRevision: 'rev-test',
    licenseNotice: 'artifacts/windows-x64/package/README.md',
    minimumPluginVersion: '0.1.3-alpha.1',
  }
}

describe('native runtime platform mapping', () => {
  it('maps exactly the six published platform ids', () => {
    expect(runtimePlatformFor('win32', 'x64')).toBe('win32-x64')
    expect(runtimePlatformFor('win32', 'arm64')).toBe('win32-arm64')
    expect(runtimePlatformFor('linux', 'x64')).toBe('linux-x64')
    expect(runtimePlatformFor('linux', 'arm64')).toBe('linux-arm64')
    expect(runtimePlatformFor('darwin', 'x64')).toBe('darwin-x64')
    expect(runtimePlatformFor('darwin', 'arm64')).toBe('darwin-arm64')
  })

  it('refuses an architecture no artifact was published for', () => {
    // The defect this pins: `arch === 'arm64' ? 'arm64' : 'x64'` answered
    // `win32-x64` on an ia32 or ppc64 host, so the manager downloaded and
    // installed a binary the machine cannot execute rather than reporting an
    // unsupported host.
    for (const architecture of ['ia32', 'ppc64', 's390x', 'riscv64', 'loong64', 'arm']) {
      expect(() => runtimePlatformFor('win32', architecture), architecture).toThrow('unsupported native runtime architecture')
    }
  })

  it('refuses an operating system no artifact was published for', () => {
    for (const platformName of ['freebsd', 'openbsd', 'aix', 'sunos', 'android']) {
      expect(() => runtimePlatformFor(platformName, 'x64'), platformName).toThrow('unsupported native runtime platform')
    }
  })

  it('reports the platform of the running process as one of the six ids', () => {
    // Not vacuous: the host must land on a published id, so a test run on an
    // unsupported architecture fails here rather than inside a spawned worker.
    expect(runtimePlatformFor(platform, arch)).toBe(`${platform}-${arch}`)
    expect(currentRuntimePlatform()).toBe(runtimePlatformFor(platform, arch))
  })
})

describe('runtime manifest validation', () => {
  it('accepts a complete manifest', () => {
    expect(validateRuntimeManifest(validManifest())).toMatchObject({ engine: 'codex', platform: 'win32-x64' })
  })

  it('refuses a value that is not an object', () => {
    for (const value of [null, undefined, 'manifest', 7, true, ['manifest']]) {
      expect(() => validateRuntimeManifest(value)).toThrow('runtime manifest must be an object')
    }
  })

  it('refuses an unknown engine, platform, or manifest version', () => {
    expect(() => validateRuntimeManifest({ ...validManifest(), engine: 'deepseek' })).toThrow('engine is invalid')
    expect(() => validateRuntimeManifest({ ...validManifest(), platform: 'win32-ia32' })).toThrow('platform is invalid')
    expect(() => validateRuntimeManifest({ ...validManifest(), manifestVersion: 2 })).toThrow('version is unsupported')
  })

  it('requires every identity field to be a non-empty string', () => {
    for (const key of ['protocolAbi', 'runtimeAbi', 'artifactPath', 'artifactDigest', 'sourceRevision', 'licenseNotice', 'minimumPluginVersion']) {
      expect(() => validateRuntimeManifest({ ...validManifest(), [key]: '' }), key).toThrow(`${key} is required`)
      expect(() => validateRuntimeManifest({ ...validManifest(), [key]: 7 }), key).toThrow(`${key} is required`)
    }
  })

  it('refuses a digest that is not SHA-256', () => {
    for (const digest of ['sha256:abc', 'md5:' + 'a'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)]) {
      expect(() => validateRuntimeManifest({ ...validManifest(), artifactDigest: digest }), digest).toThrow('artifactDigest must be SHA-256')
    }
    // Both spellings the manifests use are accepted.
    expect(() => validateRuntimeManifest({ ...validManifest(), artifactDigest: 'a'.repeat(64) })).not.toThrow()
  })

  it('refuses an argument list that is not bounded strings', () => {
    expect(() => validateRuntimeManifest({ ...validManifest(), args: 'app-server' })).toThrow('args are invalid')
    expect(() => validateRuntimeManifest({ ...validManifest(), args: [7] })).toThrow('args are invalid')
    expect(() => validateRuntimeManifest({ ...validManifest(), args: ['x'.repeat(257)] })).toThrow('args are invalid')
    expect(() => validateRuntimeManifest({ ...validManifest(), args: [] })).not.toThrow()
  })

  it('refuses a path field that leaves the artifact root', () => {
    for (const key of ['artifactPath', 'licenseNotice']) {
      for (const escape of ['..', '../outside', '../../outside', 'artifacts/../../outside', '/etc/passwd']) {
        expect(() => validateRuntimeManifest({ ...validManifest(), [key]: escape }), `${key}=${escape}`)
          .toThrow(`runtime manifest ${key} must stay inside the artifact root`)
      }
    }
  })

  it('judges containment on the normalized path, not on its text', () => {
    // A path that *contains* `..` while resolving inside is legitimate; a
    // substring test would refuse it and the install would fail on a valid
    // package.
    expect(() => validateRuntimeManifest({ ...validManifest(), artifactPath: 'artifacts/windows-x64/../windows-x64/codex.exe' })).not.toThrow()
    expect(() => validateRuntimeManifest({ ...validManifest(), artifactPath: './codex.exe' })).not.toThrow()
  })
})

describe('runtime artifact verification', () => {
  /** A root holding one artifact and its notice, with the real digests. */
  async function stagedRoot(): Promise<{ readonly root: string; readonly bytes: Buffer }> {
    const root = await mkdtemp(join(tmpdir(), 'freecodego-manifest-'))
    const packageRoot = join(root, 'artifacts', 'windows-x64', 'package')
    await mkdir(packageRoot, { recursive: true })
    const bytes = Buffer.from('#!/bin/sh\nexit 0\n')
    await writeFile(join(packageRoot, 'codex.exe'), bytes)
    await writeFile(join(packageRoot, 'README.md'), 'notice')
    return { root, bytes }
  }

  function manifestFor(bytes: Buffer): NativeRuntimeManifest {
    return {
      manifestVersion: 1,
      engine: 'codex',
      platform: runtimePlatformFor(platform, arch),
      protocolAbi: 'freecodego-agent/1',
      runtimeAbi: 'codex/1.0.0',
      artifactPath: 'artifacts/windows-x64/package/codex.exe',
      artifactDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      sourceRevision: 'rev-test',
      licenseNotice: 'artifacts/windows-x64/package/README.md',
      minimumPluginVersion: '0.1.3-alpha.1',
    }
  }

  it('accepts an artifact whose bytes hash to the declared digest', async () => {
    const { root, bytes } = await stagedRoot()
    await expect(verifyRuntimeArtifact(manifestFor(bytes), root)).resolves.toBeUndefined()
  })

  it('refuses an artifact whose bytes do not', async () => {
    const { root, bytes } = await stagedRoot()
    await expect(verifyRuntimeArtifact(manifestFor(Buffer.from('tampered')), root)).rejects.toThrow('artifact digest mismatch for codex')
    // The digest comparison is over the real bytes, so the honest manifest still
    // passes on the same root: the refusal above is the hash and not the path.
    await expect(verifyRuntimeArtifact(manifestFor(bytes), root)).resolves.toBeUndefined()
  })

  it('refuses a manifest for another platform before hashing anything', async () => {
    const { root, bytes } = await stagedRoot()
    const other: NativeRuntimeManifest = { ...manifestFor(bytes), platform: platform === 'win32' ? 'linux-x64' : 'win32-x64' }
    await expect(verifyRuntimeArtifact(other, root)).rejects.toThrow('is not supported on')
  })

  it('refuses a path that escapes the root even when the manifest was not validated', async () => {
    // Defense in depth: `verifyRuntimeArtifact` is reachable with a cast manifest,
    // so its own containment check has to stand on its own.
    const { root, bytes } = await stagedRoot()
    const escaping: NativeRuntimeManifest = { ...manifestFor(bytes), artifactPath: '../outside' }
    await expect(verifyRuntimeArtifact(escaping, root)).rejects.toThrow('escapes the artifact root')
  })

  it('requires the license notice to exist', async () => {
    const { root, bytes } = await stagedRoot()
    const missing: NativeRuntimeManifest = { ...manifestFor(bytes), licenseNotice: 'artifacts/windows-x64/package/NOTICE' }
    await expect(verifyRuntimeArtifact(missing, root)).rejects.toThrow()
  })
})
