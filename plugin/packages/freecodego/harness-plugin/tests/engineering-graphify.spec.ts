import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GraphifyRuntimeManager, GRAPHIFY_VERSION, graphifyPlatformPackages, graphifyPlatformSupport } from '../src/engineering-graphify.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

describe('official Graphify runtime manager', () => {
  it('keeps the pinned Windows, macOS, and Linux runtime matrix explicit', () => {
    for (const target of [
      ['win32', 'x64'], ['win32', 'arm64'], ['darwin', 'x64'], ['darwin', 'arm64'],
      ['linux', 'x64', 'gnu'], ['linux', 'x64', 'musl'], ['linux', 'arm64', 'gnu'], ['linux', 'arm64', 'musl'],
    ] as const) {
      expect(graphifyPlatformSupport(target[0], target[1], target[2])).toMatchObject({ supported: true })
    }
    expect(graphifyPlatformSupport('linux', 'ppc64')).toMatchObject({ supported: false })
  })

  it('selects exactly one verified platform package for automatic installation', () => {
    const windows = graphifyPlatformPackages('win32', 'x64')
    expect(windows.filter(item => item.compatible)).toEqual([
      expect.objectContaining({ platform: 'win32-x64', version: GRAPHIFY_VERSION }),
    ])
    expect(windows.every(item => item.sourceRevision.includes(`graphifyy==${GRAPHIFY_VERSION}`))).toBe(true)
  })
  it('reports an explicit unavailable state without touching a workspace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-graphify-'))
    directories.push(directory)
    const manager = new GraphifyRuntimeManager(directory)
    await expect(manager.status()).resolves.toMatchObject({ state: 'unavailable', installed: false, version: GRAPHIFY_VERSION })
    const packages = await manager.packages()
    expect(packages.map(entry => entry.id)).toEqual(['managed-uv-python', 'existing-python'])
    expect(packages.find(entry => entry.id === 'existing-python')).toMatchObject({ requiresPath: true })
  })

  it('refuses graph construction until the verified official runtime is installed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-graphify-'))
    const workspace = await mkdtemp(join(tmpdir(), 'freecodego-graphify-workspace-'))
    directories.push(directory, workspace)
    const manager = new GraphifyRuntimeManager(directory)
    await expect(manager.build(workspace)).rejects.toThrow(/尚未安装官方 Graphify Runtime/)
    await expect(manager.projectStatus(workspace)).resolves.toMatchObject({ state: 'unavailable' })
  })

  it('clears only the hashed plugin-owned project directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-graphify-'))
    const workspace = await mkdtemp(join(tmpdir(), 'freecodego-graphify-workspace-'))
    directories.push(directory, workspace)
    const normalized = resolve(workspace).replaceAll('\\', '/')
    const identity = process.platform === 'win32' ? normalized.toLowerCase() : normalized
    const projectId = createHash('sha256').update(identity).digest('hex').slice(0, 24)
    const projectDirectory = join(directory, 'projects', projectId)
    await mkdir(projectDirectory, { recursive: true })
    await writeFile(join(projectDirectory, 'marker'), 'private graph data')
    const manager = new GraphifyRuntimeManager(directory)
    await manager.clearProject(workspace)
    expect(existsSync(projectDirectory)).toBe(false)
    expect(existsSync(workspace)).toBe(true)
  })
})
