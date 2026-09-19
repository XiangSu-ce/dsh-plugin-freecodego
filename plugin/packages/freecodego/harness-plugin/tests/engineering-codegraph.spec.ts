import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CodeGraphRuntimeManager, CODEGRAPH_DIR_NAME, CODEGRAPH_VERSION,
  codegraphArchive, codegraphEnvironment, codegraphExtractArguments, codegraphLaunch, codegraphPlatformPackages, codegraphPlatformSupport, codegraphQueryArguments,
} from '../src/engineering-codegraph.ts'
import { selectGraphEngine } from '../src/engineering.ts'

// A real build needs a downloaded signed bundle AND a spawned CLI, so this suite
// exercises the engine's own orchestration against the single seam it owns: the
// process runner. Everything above — the platform matrix, the digests, the
// launcher recipe, the argument shapes — stays real.
const runner = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('../src/engineering-graphify.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engineering-graphify.ts')>()
  return {
    ...actual,
    runProcess: async (command: string, args: readonly string[]): Promise<{ readonly exitCode: number; readonly output: string }> => {
      runner.calls.push([command, ...args].join(' '))
      return { exitCode: 0, output: '' }
    },
  }
})

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

describe('official CodeGraph runtime manager', () => {
  it('keeps the pinned Windows, macOS, and Linux runtime matrix explicit', () => {
    for (const target of [['win32', 'x64'], ['win32', 'arm64'], ['darwin', 'x64'], ['darwin', 'arm64'], ['linux', 'x64'], ['linux', 'arm64']] as const) {
      expect(codegraphPlatformSupport(target[0], target[1], 'gnu')).toMatchObject({ supported: true })
    }
    expect(codegraphPlatformSupport('linux', 'ppc64')).toMatchObject({ supported: false })
  })

  it('refuses musl Linux, which the glibc-linked official bundles cannot run', () => {
    expect(codegraphPlatformSupport('linux', 'x64', 'musl')).toMatchObject({ supported: false })
    expect(codegraphArchive('linux', 'x64', 'musl')).toBeUndefined()
    expect(codegraphPlatformSupport('linux', 'x64', 'gnu')).toMatchObject({ supported: true })
  })

  it('pins one digest-verified archive per supported target', () => {
    for (const [os, arch] of [['win32', 'x64'], ['win32', 'arm64'], ['darwin', 'x64'], ['darwin', 'arm64'], ['linux', 'x64'], ['linux', 'arm64']] as const) {
      const archive = codegraphArchive(os, arch, 'gnu')
      expect(archive).toBeDefined()
      expect(archive!.digest).toMatch(/^[a-f0-9]{64}$/u)
      expect(archive!.format).toBe(os === 'win32' ? 'zip' : 'tar.gz')
      expect(archive!.asset).toBe(`codegraph-${os}-${arch}.${archive!.format}`)
    }
    expect(codegraphArchive('win32', 'x64')!.asset).toBe('codegraph-win32-x64.zip')
    expect(codegraphArchive('darwin', 'arm64')!.asset).toBe('codegraph-darwin-arm64.tar.gz')
  })

  it('selects exactly one installable, path-free package for this platform', () => {
    const windows = codegraphPlatformPackages('win32', 'x64')
    expect(windows.filter(item => item.compatible)).toEqual([expect.objectContaining({ id: 'managed-bundle', label: expect.stringContaining('win32-x64') })])
    expect(windows.every(item => ! item.requiresPath)).toBe(true)
    expect(windows.find(item => item.compatible)!.detail).toContain('无需 Python')
  })

  it('explains an unsupported host on the row for that host', () => {
    const musl = codegraphPlatformPackages('linux', 'x64', 'musl')
    expect(musl.filter(item => item.compatible)).toEqual([])
    expect(musl.find(item => item.label.includes('linux-x64'))!.detail).toContain('musl')
  })

  it('launches the bundled runtime directly and never the Windows .cmd launcher', () => {
    const bundle = join(tmpdir(), 'codegraph-bundle')
    const windows = codegraphLaunch(bundle, ['query', 'alpha'], 'win32')
    expect(windows.command).toBe(join(bundle, 'node.exe'))
    expect(windows.args).toEqual([
      '--liftoff-only', '--disable-warning=ExperimentalWarning',
      join(bundle, 'lib', 'dist', 'bin', 'codegraph.js'), 'query', 'alpha',
    ])
    const linux = codegraphLaunch(bundle, ['query', 'alpha'], 'linux')
    expect(linux.command).toBe(join(bundle, 'bin', 'codegraph'))
    expect(linux.args).toEqual(['query', 'alpha'])
  })

  it('unpacks zip and tar archives with the matching tar flags', () => {
    expect(codegraphExtractArguments('a.zip', 'dest', 'zip')).toEqual(['-xf', 'a.zip', '-C', 'dest', '--strip-components=1'])
    expect(codegraphExtractArguments('a.tar.gz', 'dest', 'tar.gz')).toEqual(['-xzf', 'a.tar.gz', '-C', 'dest', '--strip-components=1'])
  })

  it('keeps the runtime local: no telemetry, no daemon, no self-download', () => {
    const previous = process.env.FREECODEGO_LEAK_CHECK
    process.env.FREECODEGO_LEAK_CHECK = 'host-secret'
    try {
      const environment = codegraphEnvironment({ EXTRA: 'value' })
      expect(environment).toMatchObject({
        CODEGRAPH_DIR: CODEGRAPH_DIR_NAME,
        CODEGRAPH_NO_DAEMON: '1',
        CODEGRAPH_NO_DOWNLOAD: '1',
        CODEGRAPH_TELEMETRY: '0',
        DO_NOT_TRACK: '1',
        EXTRA: 'value',
      })
      expect(environment.FREECODEGO_LEAK_CHECK).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.FREECODEGO_LEAK_CHECK
      else process.env.FREECODEGO_LEAK_CHECK = previous
    }
  })

  it('builds only fixed read-only command shapes', () => {
    expect(codegraphQueryArguments('search', ['UserService'], '/ws', undefined, undefined)).toEqual(['query', 'UserService', '--path', '/ws', '--limit', '10', '--json'])
    expect(codegraphQueryArguments('search', ['a'], '/ws', undefined, 9_999)[5]).toBe('50')
    expect(codegraphQueryArguments('symbol', ['a'], '/ws', undefined, undefined)).toEqual(['node', 'a', '--path', '/ws'])
    expect(codegraphQueryArguments('impact', ['a'], '/ws', 3, undefined)).toEqual(['impact', 'a', '--path', '/ws', '--depth', '3', '--json'])
    expect(codegraphQueryArguments('impact', ['a'], '/ws', 99, undefined)[5]).toBe('5')
    expect(codegraphQueryArguments('explore', ['how', 'does', 'a', 'reach', 'b'], '/ws', undefined, 4)).toEqual(['explore', 'how does a reach b', '--path', '/ws', '--max-files', '4'])
    // A flow query must stay ONE argument: a bare `->` token would be parsed as an option.
    expect(codegraphQueryArguments('path', ['from', 'to'], '/ws', undefined, undefined)[1]).toBe('from -> to')
    expect(() => codegraphQueryArguments('path', ['only-one'], '/ws', undefined, undefined)).toThrow(/两个节点名称/u)
    expect(() => codegraphQueryArguments('search', ['a', 'b'], '/ws', undefined, undefined)).toThrow(/需要一个文本或节点名称/u)
    expect(() => codegraphQueryArguments('explore', [], '/ws', undefined, undefined)).toThrow(/需要一个查询文本/u)
  })

  it('reports an explicit unavailable state and refuses work without a verified runtime', async () => {
    const runtimeRoot = await scratch('freecodego-codegraph-')
    const workspace = await scratch('freecodego-codegraph-ws-')
    const manager = new CodeGraphRuntimeManager(runtimeRoot)
    await expect(manager.status()).resolves.toMatchObject({ state: 'unavailable', installed: false, version: CODEGRAPH_VERSION })
    await expect(manager.build(workspace)).rejects.toThrow(/CodeGraph Runtime/u)
    await expect(manager.projectStatus(workspace)).resolves.toMatchObject({ state: 'unavailable' })
    await expect(manager.query(workspace, { command: 'search', values: ['alpha'] })).rejects.toThrow(/CodeGraph Runtime/u)
  })

  it('keeps the index inside the workspace under the plugin-specific directory name', async () => {
    const runtimeRoot = await scratch('freecodego-codegraph-')
    const workspace = await scratch('freecodego-codegraph-ws-')
    const manager = new CodeGraphRuntimeManager(runtimeRoot)
    const status = await manager.projectStatus(workspace)
    expect(status.indexPath).toBe(join(resolve(workspace), CODEGRAPH_DIR_NAME, 'codegraph.db'))
    expect(status.indexPath.startsWith(resolve(workspace))).toBe(true)
    expect(status.state).toBe('unavailable')
  })

  it('mounts exactly one engine family and never silently substitutes one for the other', () => {
    // auto prefers the Python-free engine, then falls back to whichever exists.
    expect(selectGraphEngine('auto', true, true)).toBe('codegraph')
    expect(selectGraphEngine('auto', true, false)).toBe('graphify')
    expect(selectGraphEngine('auto', false, true)).toBe('codegraph')
    expect(selectGraphEngine('auto', false, false)).toBeUndefined()
    // An explicit choice yields that engine or nothing: the two families answer
    // the same questions with different tools, so a silent swap would surprise
    // both the user and the Agent.
    expect(selectGraphEngine('graphify', true, true)).toBe('graphify')
    expect(selectGraphEngine('graphify', false, true)).toBeUndefined()
    expect(selectGraphEngine('codegraph', true, true)).toBe('codegraph')
    expect(selectGraphEngine('codegraph', true, false)).toBeUndefined()
  })

  it('reports a finished build as ready instead of still building', async () => {
    const archive = codegraphArchive()
    // No verified bundle exists for this host, so there is nothing to stand up.
    if (archive === undefined) return
    const runtimeRoot = await scratch('freecodego-codegraph-')
    const workspace = await scratch('freecodego-codegraph-ws-')
    // An installed runtime as `status()` defines it: a manifest naming the pinned
    // version, target, and digest, plus the launcher path it would execute.
    const target = codegraphPlatformSupport().id
    const runtimeDirectory = join(runtimeRoot, 'runtime', `codegraph-${CODEGRAPH_VERSION}-${target}`)
    await mkdir(runtimeDirectory, { recursive: true })
    const launcher = codegraphLaunch(runtimeDirectory, ['version']).command
    await mkdir(dirname(launcher), { recursive: true })
    await writeFile(launcher, '')
    await writeFile(join(runtimeDirectory, 'runtime-state.json'), JSON.stringify({ version: CODEGRAPH_VERSION, target, bundleDigest: archive.digest, installedAt: Date.now() }))
    // An existing index makes `build` take the incremental path.
    await mkdir(join(workspace, CODEGRAPH_DIR_NAME), { recursive: true })
    await writeFile(join(workspace, CODEGRAPH_DIR_NAME, 'codegraph.db'), 'index')
    const manager = new CodeGraphRuntimeManager(runtimeRoot)
    await expect(manager.status()).resolves.toMatchObject({ installed: true })
    // `projectStatus` answers `building` straight from the build claim, so a
    // build that derives its status while still holding the claim reports a
    // finished build as running — and the panel then keeps offering "cancel".
    await expect(manager.build(workspace)).resolves.toMatchObject({ state: 'ready' })
    await expect(manager.projectStatus(workspace)).resolves.toMatchObject({ state: 'ready' })
    expect(runner.calls.at(-1)).toContain('sync')
  })

  it('clears only its own index directory and never a user-owned .codegraph', async () => {
    const runtimeRoot = await scratch('freecodego-codegraph-')
    const workspace = await scratch('freecodego-codegraph-ws-')
    const ownIndex = join(workspace, CODEGRAPH_DIR_NAME)
    const userIndex = join(workspace, '.codegraph')
    await mkdir(ownIndex, { recursive: true })
    await mkdir(userIndex, { recursive: true })
    await writeFile(join(ownIndex, 'codegraph.db'), 'plugin index')
    await writeFile(join(userIndex, 'codegraph.db'), 'user index')
    const manager = new CodeGraphRuntimeManager(runtimeRoot)
    await manager.clearProject(workspace)
    expect(existsSync(ownIndex)).toBe(false)
    expect(existsSync(join(userIndex, 'codegraph.db'))).toBe(true)
    expect(existsSync(workspace)).toBe(true)
  })
})
