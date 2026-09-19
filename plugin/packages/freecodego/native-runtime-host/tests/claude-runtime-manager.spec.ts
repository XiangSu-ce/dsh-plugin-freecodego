import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaudeRuntimeManager } from '../src/claude-runtime-manager.ts'

/**
 * A fake installation the manager treats as complete: the marker it reads, the
 * `.complete` gate, and the CLI binary the identity hashes.
 */
async function installedRuntime(options: { readonly sdkVersion?: unknown }) {
  const directory = await mkdtemp(join(tmpdir(), 'freecodego-claude-runtime-'))
  const packageRoot = join(directory, 'package')
  const runtimeRoot = join(directory, 'runtime')
  const executableName = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const platform = process.platform === 'win32' ? 'win32-x64' : `${process.platform}-${process.arch}`
  mkdirSync(packageRoot, { recursive: true })
  mkdirSync(join(runtimeRoot, 'cli'), { recursive: true })
  const manifestPath = join(packageRoot, 'package.json')
  writeFileSync(manifestPath, JSON.stringify({
    dependencies: options.sdkVersion === undefined ? {} : { '@anthropic-ai/claude-agent-sdk': options.sdkVersion },
  }))
  writeFileSync(join(runtimeRoot, 'cli', executableName), 'official-cli')
  writeFileSync(join(runtimeRoot, '.complete'), 'official-cli\n')
  writeFileSync(join(runtimeRoot, 'claude-agent-sdk-runtime.json'), JSON.stringify({
    formatVersion: 1,
    engine: 'claude',
    platform,
    protocolAbi: 'freecodego-agent/1',
    runtimeVersion: 'claude-agent-sdk-worker/0.3.246',
    artifactDigest: 'sha256:recorded-at-install-time',
    sourceRevision: `npm:@anthropic-ai/claude-agent-sdk-${platform}@0.3.246`,
    executablePath: `cli/${executableName}`,
  }))
  return { runtimeRoot, manifestPath }
}

describe('ClaudeRuntimeManager', () => {
  it('offers the current official SDK package without retaining the retired agent core artifact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-claude-runtime-'))
    const manager = new ClaudeRuntimeManager({ rootDirectory: join(directory, 'runtime') })

    expect(manager.status()).toMatchObject({ installed: false, reason: 'CLAUDE_RUNTIME_NOT_INSTALLED' })
    const packages = manager.packages()
    expect(packages).toHaveLength(6)
    expect(packages.find(item => item.compatible)).toMatchObject({ source: 'official', platform: process.platform === 'win32' ? 'win32-x64' : expect.any(String) })
    await expect(manager.install('claude:unsupported:0.3.246')).rejects.toThrow('not compatible')
    await expect(manager.remove()).resolves.toMatchObject({ installed: false, reason: 'CLAUDE_RUNTIME_NOT_INSTALLED' })
  })

  it('derives the runtime identity from the driver manifest and the downloaded CLI', async () => {
    const fixture = await installedRuntime({ sdkVersion: '0.4.0' })
    const manager = new ClaudeRuntimeManager({ rootDirectory: fixture.runtimeRoot, engineManifestPath: fixture.manifestPath })

    expect(manager.status()).toMatchObject({ installed: true })
    const identity = await manager.runtime()
    // `status()` echoes the runtimeVersion recorded in the marker; the identity
    // recomputes from live files, because its digest is what a durable plan is
    // checked against.
    expect(identity.runtimeVersion).toBe('claude-agent-sdk-worker/0.4.0')
    expect(identity.sourceRevision).toContain('@0.4.0')
    expect(identity).not.toHaveProperty('workerPath')
    expect(identity.artifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/u)

    // A repinned SDK is a different runtime: the digest has to move with it, or a
    // durable plan made under the old pin would be accepted under the new one.
    writeFileSync(fixture.manifestPath, JSON.stringify({ dependencies: { '@anthropic-ai/claude-agent-sdk': '0.4.1' } }))
    const repinned = await manager.runtime()
    expect(repinned.artifactDigest).not.toBe(identity.artifactDigest)
    expect(repinned.runtimeVersion).toBe('claude-agent-sdk-worker/0.4.1')
  })

  it('fails closed with the expected path when the driver manifest is missing', async () => {
    const fixture = await installedRuntime({ sdkVersion: '0.4.0' })
    const manager = new ClaudeRuntimeManager({
      rootDirectory: fixture.runtimeRoot,
      engineManifestPath: join(fixture.manifestPath, '..', 'absent-package.json'),
    })
    await expect(manager.runtime()).rejects.toThrow(/driver manifest is missing/u)
  })

  it('rejects a driver manifest that does not pin an exact SDK version', async () => {
    const fixture = await installedRuntime({ sdkVersion: '0.4' })
    const manager = new ClaudeRuntimeManager({ rootDirectory: fixture.runtimeRoot, engineManifestPath: fixture.manifestPath })
    await expect(manager.runtime()).rejects.toThrow(/driver dependency version is missing/u)
  })
})
