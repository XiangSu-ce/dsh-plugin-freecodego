/** Plugin-owned launcher for the official Graphify runtime and private output roots. */

import { createHash, randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { platform } from 'node:os'
import { dirname, join, normalize, resolve } from 'node:path'
import { gunzipSync, inflateRawSync } from 'node:zlib'
import type { FreeCodeGoEngineeringCanvasGraph, FreeCodeGoEngineeringGraphProjectStatus, FreeCodeGoEngineeringGraphRuntimePackage, FreeCodeGoEngineeringGraphRuntimeStatus } from './types.ts'
import { freeCodeGoDataHome } from './data-home.ts'
import { BuildTracker, downloadVerifiedAsset, ensurePrivateDirectory as ensurePrivateRuntimeDirectory, readRuntimeManifest, replaceVerifiedRuntimeDirectory, writeRuntimeManifest } from './engineering-runtime-store.ts'

export const GRAPHIFY_VERSION = '0.9.52'
const GRAPHIFY_WHEEL_URL = 'https://files.pythonhosted.org/packages/eb/14/8a015f6b3e5e3dc06a762e9dc5b722097900832b322b922484dc2ae7a92a/graphifyy-0.9.52-py3-none-any.whl'
const GRAPHIFY_WHEEL_SHA256 = '5588ea9af433a8cf74ada89dfc0b981abf596a1327a1375fdaf661905562bf44'
const MAX_WHEEL_BYTES = 4 * 1024 * 1024
const MAX_UV_ARCHIVE_BYTES = 40 * 1024 * 1024
const INSTALL_TIMEOUT_MS = 10 * 60_000
const BUILD_TIMEOUT_MS = 15 * 60_000
const QUERY_TIMEOUT_MS = 30_000
const OUTPUT_LIMIT = 64 * 1024

type RuntimeManifest = {
  readonly version: string
  readonly wheelDigest: string
  readonly pythonRelativePath: string
  readonly installedAt: number
  readonly installMode: 'managed-uv-python' | 'existing-python'
}

type GraphifyPlatformPackage = {
  readonly id: 'managed-uv-python'
  readonly platform: string
  readonly label: string
  readonly version: string
  readonly sourceRevision: string
  readonly downloadURL: string
  readonly compatible: boolean
}

export type ProcessResult = { readonly exitCode: number; readonly output: string }
type UvArchive = { readonly url: string; readonly digest: string; readonly format: 'zip' | 'tar.gz' }

const UV_ARCHIVES: Readonly<Record<string, UvArchive>> = {
  'win32-x64': { format: 'zip', digest: 'bf1518af459a3915511a11fdc6e2f43ef9a2afa138b9d498eeb9642fe9d85218', url: 'https://github.com/astral-sh/uv/releases/download/0.12.7/uv-x86_64-pc-windows-msvc.zip' },
  'win32-arm64': { format: 'zip', digest: '1611d0f4be72b0a354ad9a6ae954093dd4c91e93e36b8b490326a05a039ffe14', url: 'https://github.com/astral-sh/uv/releases/download/0.12.7/uv-aarch64-pc-windows-msvc.zip' },
  'darwin-x64': { format: 'tar.gz', digest: '06b8ae1da8c2661c5434507a66f8c2b0b835933bf955b5958a9ac357a37d1959', url: 'https://github.com/astral-sh/uv/releases/download/0.12.7/uv-x86_64-apple-darwin.tar.gz' },
  'darwin-arm64': { format: 'tar.gz', digest: '127ebdda7ad953cdf198e964b570ea5771b85467ea93eb7cb6d6f8e6f55408f3', url: 'https://github.com/astral-sh/uv/releases/download/0.12.7/uv-aarch64-apple-darwin.tar.gz' },
  'linux-x64-gnu': { format: 'tar.gz', digest: '788f18abea7c5f55d6216e4f5613fd89d4d59b631efeec117b2b07fe72f1da21', url: 'https://github.com/astral-sh/uv/releases/download/0.12.7/uv-x86_64-unknown-linux-gnu.tar.gz' },
  'linux-arm64-gnu': { format: 'tar.gz', digest: '66393193038dd7eb108abd7a218d9cec04ac70ab98242b0720fa94de19223b7c', url: 'https://github.com/astral-sh/uv/releases/download/0.12.7/uv-aarch64-unknown-linux-gnu.tar.gz' },
  'linux-x64-musl': { format: 'tar.gz', digest: '3d64d44ed67da7908dc7f5c4d64ebb44bad326fa17f8a0a52fc9a7793017bbe1', url: 'https://github.com/astral-sh/uv/releases/download/0.12.7/uv-x86_64-unknown-linux-musl.tar.gz' },
  'linux-arm64-musl': { format: 'tar.gz', digest: '6dcf60e3c085de88ace3671b949ca99f0652be561ff5627f0d21394140f041db', url: 'https://github.com/astral-sh/uv/releases/download/0.12.7/uv-aarch64-unknown-linux-musl.tar.gz' },
}

/** Pure platform resolver exercised in CI for every supported desktop target. */
export function graphifyPlatformSupport(os = platform(), architecture = process.arch, libc?: 'gnu' | 'musl'): { readonly id: string; readonly supported: boolean; readonly detail: string } {
  const arch = architecture === 'arm64' ? 'arm64' : architecture === 'x64' ? 'x64' : undefined
  const resolvedLibc = os === 'linux'
    ? libc ?? ((process.report?.getReport() as { readonly header?: { readonly glibcVersionRuntime?: unknown } } | undefined)?.header?.glibcVersionRuntime ? 'gnu' : 'musl')
    : undefined
  const id = os === 'linux' ? `linux-${arch ?? architecture}-${resolvedLibc}` : `${os}-${arch ?? architecture}`
  return UV_ARCHIVES[id] === undefined
    ? { id, supported: false, detail: 'No pinned official uv archive exists for this OS/CPU/libc target.' }
    : { id, supported: true, detail: 'Pinned official uv archive and Graphify private-runtime flow are available.' }
}

/** The Graphify equivalent of Claude's runtime package directory. The active
 * platform is the only auto-installable row; all other rows stay visible for
 * diagnostics and are intentionally not downloadable from this machine. */
export function graphifyPlatformPackages(os = platform(), architecture = process.arch, libc?: 'gnu' | 'musl'): readonly GraphifyPlatformPackage[] {
  const active = graphifyPlatformSupport(os, architecture, libc)
  return Object.entries(UV_ARCHIVES).map(([platform, archive]) => ({
    id: 'managed-uv-python' as const,
    platform,
    label: `Graphify ${GRAPHIFY_VERSION} (${platform})`,
    version: GRAPHIFY_VERSION,
    sourceRevision: `graphifyy==${GRAPHIFY_VERSION}; uv@0.12.7:${platform}`,
    downloadURL: archive.url,
    compatible: platform === active.id,
  }))
}

/** Executes only fixed Graphify arguments and stores all artifacts under DSH_HOME. */
export class GraphifyRuntimeManager {
  private readonly rootDirectory: string
  private installTask: Promise<FreeCodeGoEngineeringGraphRuntimeStatus> | undefined
  private readonly builds = new BuildTracker()

  constructor(rootDirectory = defaultGraphifyDirectory()) {
    this.rootDirectory = resolve(rootDirectory)
  }

  async status(): Promise<FreeCodeGoEngineeringGraphRuntimeStatus> {
    if (this.installTask !== undefined) return { state: 'installing', installed: false, version: GRAPHIFY_VERSION, runtimeDirectory: this.runtimeDirectory() }
    const manifest = await this.readManifest()
    const pythonPath = manifest === undefined ? undefined : resolve(this.runtimeDirectory(), manifest.pythonRelativePath)
    if (manifest === undefined || pythonPath === undefined || !existsSync(pythonPath)) {
      return {
        state: 'unavailable', installed: false, version: GRAPHIFY_VERSION, runtimeDirectory: this.runtimeDirectory(),
        reason: manifest === undefined ? '尚未安装官方 Graphify Runtime。' : 'Graphify Runtime 清单或私有 Python 缺失，请重新安装。',
      }
    }
    if (manifest.version !== GRAPHIFY_VERSION || manifest.wheelDigest !== GRAPHIFY_WHEEL_SHA256) {
      return { state: 'error', installed: false, version: GRAPHIFY_VERSION, runtimeDirectory: this.runtimeDirectory(), reason: '已安装 Graphify Runtime 与当前经过验证的版本或校验值不一致。' }
    }
    return { state: 'ready', installed: true, version: GRAPHIFY_VERSION, runtimeDirectory: this.runtimeDirectory(), pythonPath, wheelDigest: manifest.wheelDigest }
  }

  async packages(): Promise<readonly FreeCodeGoEngineeringGraphRuntimePackage[]> {
    const platformPackage = graphifyPlatformPackages().find(entry => entry.compatible)
    const compatible = platformPackage !== undefined
    const detectedPython = detectPythonExecutable()
    return [
      {
        id: 'managed-uv-python', label: '自动安装代码图环境',
        detail: compatible ? `已匹配当前平台 ${platformPackage.platform}，将下载并校验官方代码图环境，然后隔离安装。` : '当前系统暂未提供经过验证的代码图运行环境。',
        compatible, requiresPath: false,
      },
      {
        id: 'existing-python', label: '使用本机 Python（自动隔离）',
        detail: detectedPython === undefined
          ? '需要 Python 3.10 或更高版本。代码图依赖仍安装在插件自己的隔离目录。'
          : `已找到可用的 Python：${detectedPython}。安装前会验证版本，并把代码图依赖放在插件自己的隔离目录。`,
        compatible: true, requiresPath: true, ...(detectedPython === undefined ? {} : { detectedPath: detectedPython }),
      },
    ]
  }

  async install(input: { readonly packageId: 'managed-uv-python' | 'existing-python'; readonly pythonPath?: string }): Promise<FreeCodeGoEngineeringGraphRuntimeStatus> {
    if (this.installTask !== undefined) return this.installTask
    const task = this.installOfficialRuntime(input)
    this.installTask = task
    try { return await task } finally { this.installTask = undefined }
  }

  async remove(): Promise<FreeCodeGoEngineeringGraphRuntimeStatus> {
    if (this.installTask !== undefined) throw new Error('Graphify Runtime 安装仍在进行，无法删除。')
    await rm(this.runtimeDirectory(), { recursive: true, force: true })
    return this.status()
  }

  async projectStatus(cwd: string): Promise<FreeCodeGoEngineeringGraphProjectStatus> {
    const projectId = projectIdFor(cwd)
    const graphPath = this.graphPath(cwd)
    if (this.builds.isBuilding(projectId)) return { state: 'building', projectId, graphPath }
    const runtime = await this.status()
    if (!runtime.installed) return { state: 'unavailable', projectId, graphPath, reason: runtime.reason ?? 'Graphify Runtime 未安装。' }
    try {
      const info = await stat(graphPath)
      return { state: 'ready', projectId, graphPath, builtAt: info.mtimeMs, graphBytes: info.size }
    } catch {
      return { state: 'missing', projectId, graphPath, reason: '当前工作区尚未构建代码结构图。' }
    }
  }

  /** Build Graphify's official code-only graph without writing graphify-out into the workspace. */
  async build(cwd: string, force = false, signal?: AbortSignal): Promise<FreeCodeGoEngineeringGraphProjectStatus> {
    const workspace = resolve(cwd)
    const workspaceInfo = await stat(workspace).catch(() => undefined)
    if (workspaceInfo?.isDirectory() !== true) throw new Error('Graphify 工作区路径不存在或不是目录。')
    const runtime = await this.status()
    if (!runtime.installed || runtime.pythonPath === undefined) throw new Error(runtime.reason ?? 'Graphify Runtime 未安装。')
    const projectId = projectIdFor(workspace)
    // Claim the workspace before any await: the directory preparation below
    // must not open a window where two builds for one workspace both pass the
    // concurrency check and race on the same output directory.
    this.builds.claim(projectId, '该工作区的 Graphify 构建已在进行。')
    try {
      const outputDirectory = this.projectOutputDirectory(workspace)
      await this.ensurePrivateDirectory(outputDirectory)
      const controller = linkedController(signal)
      this.builds.attach(projectId, controller)
      const result = await runProcess(runtime.pythonPath, ['-m', 'graphify', 'extract', workspace, '--code-only', '--no-cluster', '--out', outputDirectory, ...(force ? ['--force'] : [])], {
        cwd: outputDirectory,
        timeout: BUILD_TIMEOUT_MS,
        env: this.graphifyEnvironment(outputDirectory),
        signal: controller.signal,
      })
      if (result.exitCode !== 0) throw new Error(`Graphify 构建失败：${result.output || `退出码 ${result.exitCode}`}`)
    } finally {
      this.builds.release(projectId)
    }
    // Read the status only after the claim is released: `projectStatus` answers
    // `building` straight from the claim, so deriving it while the claim is
    // still held reports a finished build as still running.
    return this.projectStatus(workspace)
  }

  /** Incrementally refresh an existing official graph using Graphify's manifest and shrink guard. */
  async update(cwd: string, signal?: AbortSignal): Promise<FreeCodeGoEngineeringGraphProjectStatus> {
    const workspace = resolve(cwd)
    const project = await this.projectStatus(workspace)
    if (project.state !== 'ready') throw new Error(project.reason ?? '当前工作区尚未构建代码结构图。')
    const runtime = await this.status()
    if (!runtime.installed || runtime.pythonPath === undefined) throw new Error(runtime.reason ?? 'Graphify Runtime 未安装。')
    const projectId = projectIdFor(workspace)
    this.builds.claim(projectId, '该工作区的 Graphify 构建已在进行。')
    const outputDirectory = this.projectOutputDirectory(workspace)
    const controller = linkedController(signal)
    this.builds.attach(projectId, controller)
    try {
      const result = await runProcess(runtime.pythonPath, ['-m', 'graphify', 'update', workspace, '--no-cluster'], {
        cwd: outputDirectory,
        timeout: BUILD_TIMEOUT_MS,
        env: this.graphifyEnvironment(outputDirectory),
        signal: controller.signal,
      })
      if (result.exitCode !== 0) throw new Error(`Graphify 增量更新失败：${result.output || `退出码 ${result.exitCode}`}`)
    } finally {
      this.builds.release(projectId)
    }
    // Same rule as `build`: the release comes before the status is derived.
    return this.projectStatus(workspace)
  }

  /** Abort the plugin-owned Graphify process tree for the current workspace. */
  cancel(cwd: string): { readonly cancelled: boolean } {
    return this.builds.cancel(projectIdFor(cwd))
  }

  /** Remove only the current workspace's plugin-owned graph and caches. */
  async clearProject(cwd: string): Promise<FreeCodeGoEngineeringGraphProjectStatus> {
    const projectId = projectIdFor(cwd)
    if (this.builds.isBuilding(projectId)) throw new Error('Graphify 构建进行中，无法清空项目图谱。')
    const target = resolve(this.projectOutputDirectory(cwd))
    const projectsRoot = resolve(this.rootDirectory, 'projects')
    if (dirname(target) !== projectsRoot) throw new Error('Graphify 项目目录不在插件私有根目录内。')
    await rm(target, { recursive: true, force: true })
    return this.projectStatus(cwd)
  }

  /** Run a read-only official Graphify CLI query against the plugin-owned graph. */
  async query(cwd: string, input: { readonly command: 'query' | 'explain' | 'path' | 'affected' | 'god-nodes'; readonly values?: readonly string[]; readonly depth?: number; readonly budget?: number }): Promise<{ readonly output: string; readonly project: FreeCodeGoEngineeringGraphProjectStatus }> {
    const project = await this.projectStatus(cwd)
    if (project.state !== 'ready') throw new Error(project.reason ?? '当前工作区的代码结构图不可用。')
    const runtime = await this.status()
    if (!runtime.installed || runtime.pythonPath === undefined) throw new Error(runtime.reason ?? 'Graphify Runtime 未安装。')
    const values = (input.values ?? []).map(value => value.trim()).filter(value => value !== '')
    const args = graphifyQueryArguments(input.command, values, project.graphPath, input.depth, input.budget)
    const result = await runProcess(runtime.pythonPath, ['-m', 'graphify', ...args], { cwd: this.projectOutputDirectory(cwd), timeout: QUERY_TIMEOUT_MS, env: this.graphifyEnvironment(this.projectOutputDirectory(cwd)) })
    if (result.exitCode !== 0) throw new Error(`Graphify 查询失败：${result.output || `退出码 ${result.exitCode}`}`)
    return { output: result.output, project }
  }

  /** Bounded graph payload for a compatible Canvas plugin. Never returns raw Graphify JSON. */
  async canvas(cwd: string, maxNodes = 160): Promise<FreeCodeGoEngineeringCanvasGraph> {
    const project = await this.projectStatus(cwd)
    if (project.state !== 'ready') throw new Error(project.reason ?? '当前工作区的代码结构图不可用。')
    // The graph file is read fully to pick its head nodes; guard the size so a
    // huge monorepo graph cannot stall or OOM the Host on a repeated tool call.
    const MAX_GRAPH_BYTES = 64 * 1024 * 1024
    if (project.graphBytes !== undefined && project.graphBytes > MAX_GRAPH_BYTES) {
      throw new Error(`Graphify 图文件过大（${Math.round(project.graphBytes / (1024 * 1024))} MB），请先执行 graph prune 或减小仓库范围。`)
    }
    let document: unknown
    try { document = JSON.parse(await readFile(project.graphPath, 'utf8')) } catch { throw new Error('Graphify 图文件无法读取或不是有效 JSON。') }
    const root = document !== null && typeof document === 'object' && !Array.isArray(document) ? document as Record<string, unknown> : {}
    const rawNodes = Array.isArray(root.nodes) ? root.nodes : Array.isArray(root.entities) ? root.entities : []
    const rawEdges = Array.isArray(root.edges) ? root.edges : Array.isArray(root.relationships) ? root.relationships : []
    const limit = clamp(maxNodes, 1, 400)
    const nodes = rawNodes.slice(0, limit).flatMap((item) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return []
      const value = item as Record<string, unknown>
      const id = stringField(value, ['id', 'node_id', 'name', 'qualified_name'])
      if (id === undefined) return []
      return [{ id, label: stringField(value, ['label', 'name', 'qualified_name']) ?? id, ...(stringField(value, ['kind', 'type']) === undefined ? {} : { kind: stringField(value, ['kind', 'type'])! }) }]
    })
    const visible = new Set(nodes.map(node => node.id))
    const edges = rawEdges.slice(0, 2_000).flatMap((item) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return []
      const value = item as Record<string, unknown>
      const from = stringField(value, ['from', 'source', 'source_id'])
      const to = stringField(value, ['to', 'target', 'target_id'])
      if (from === undefined || to === undefined || !visible.has(from) || !visible.has(to)) return []
      const kind = stringField(value, ['kind', 'type', 'relation'])
      return [{ from, to, ...(kind === undefined ? {} : { kind }) }]
    })
    return { projectId: project.projectId, generatedAt: Date.now(), nodes, edges, truncated: rawNodes.length > nodes.length || rawEdges.length > edges.length }
  }

  private async installOfficialRuntime(input: { readonly packageId: 'managed-uv-python' | 'existing-python'; readonly pythonPath?: string }): Promise<FreeCodeGoEngineeringGraphRuntimeStatus> {
    if (input.packageId !== 'managed-uv-python' && input.packageId !== 'existing-python') throw new Error('未知的 Graphify Runtime 安装包。')
    const requestedPython = input.packageId === 'existing-python' ? input.pythonPath?.trim() : '3.12'
    if (requestedPython === undefined || requestedPython === '') throw new Error('使用已有 Python 时必须提供 Python 可执行文件路径。')
    if (input.packageId === 'existing-python' && !existsSync(resolve(requestedPython))) throw new Error('指定的 Python 可执行文件不存在。')
    await this.ensurePrivateDirectory(this.rootDirectory)
    const uv = await this.ensureUv()
    const staging = join(this.rootDirectory, `.install-${randomUUID()}`)
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true, mode: 0o700 })
    const venvDirectory = join(staging, 'venv')
    const environment = this.graphifyEnvironment(staging)
    try {
      if (input.packageId === 'existing-python') await validateExistingPython(requestedPython, staging, environment)
      const venvArguments = input.packageId === 'managed-uv-python'
        ? ['venv', '--relocatable', '--managed-python', '--python', requestedPython, venvDirectory]
        : ['venv', '--relocatable', '--no-managed-python', '--python', requestedPython, venvDirectory]
      const venv = await runProcess(uv, venvArguments, { cwd: staging, timeout: INSTALL_TIMEOUT_MS, env: environment })
      if (venv.exitCode !== 0) throw new Error(`Graphify 私有 Python 环境创建失败：${venv.output || `退出码 ${venv.exitCode}`}`)
      const pythonPath = pythonPathForVenv(venvDirectory)
      if (!existsSync(pythonPath)) throw new Error('Graphify 私有 Python 环境未生成可执行文件。')
      const wheelPath = join(staging, 'graphifyy-0.9.52-py3-none-any.whl')
      await downloadVerifiedWheel(wheelPath)
      const install = await runProcess(uv, ['pip', 'install', '--python', pythonPath, '--only-binary', ':all:', wheelPath, 'mcp>=1,<3', 'starlette>=1.3.1,<2'], { cwd: staging, timeout: INSTALL_TIMEOUT_MS, env: environment })
      if (install.exitCode !== 0) throw new Error(`官方 Graphify Wheel 安装失败：${install.output || `退出码 ${install.exitCode}`}`)
      const check = await runProcess(pythonPath, ['-m', 'graphify', '--version'], { cwd: staging, timeout: QUERY_TIMEOUT_MS, env: environment })
      if (check.exitCode !== 0 || !new RegExp(`\\b${GRAPHIFY_VERSION.replaceAll('.', '\\.')}\\b`).test(check.output)) throw new Error(`已安装 Graphify 版本验证失败：${check.output || `退出码 ${check.exitCode}`}`)
      const manifest: RuntimeManifest = {
        version: GRAPHIFY_VERSION,
        wheelDigest: GRAPHIFY_WHEEL_SHA256,
        pythonRelativePath: relativePythonPath(),
        installedAt: Date.now(),
        installMode: input.packageId,
      }
      await writeRuntimeManifest(staging, manifest)
      await rm(wheelPath, { force: true })
      const installedPython = resolve(this.runtimeDirectory(), relativePythonPath())
      // Published, then verified at the path it will actually run from. A
      // `--relocatable` environment can still fail after a move, and the answer
      // to that is the previous runtime back — not the delete this used to do,
      // which left a repair of a working install with nothing at all.
      await replaceVerifiedRuntimeDirectory({
        staging,
        target: this.runtimeDirectory(),
        verify: async (published) => {
          const relocatedCheck = await runProcess(resolve(published, relativePythonPath()), ['-m', 'graphify', '--version'], { cwd: published, timeout: QUERY_TIMEOUT_MS, env: this.graphifyEnvironment(published) })
          if (relocatedCheck.exitCode !== 0 || !new RegExp(`\\b${GRAPHIFY_VERSION.replaceAll('.', '\\.')}\\b`).test(relocatedCheck.output)) {
            throw new Error(`Graphify 私有环境移动后的验证失败：${relocatedCheck.output || `退出码 ${relocatedCheck.exitCode}`}`)
          }
        },
      })
      return {
        state: 'ready', installed: true, version: GRAPHIFY_VERSION, runtimeDirectory: this.runtimeDirectory(),
        pythonPath: installedPython, wheelDigest: GRAPHIFY_WHEEL_SHA256,
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
  }

  private runtimeDirectory(): string { return join(this.rootDirectory, 'runtime', `graphifyy-${GRAPHIFY_VERSION}`) }
  private graphPath(cwd: string): string { return join(this.projectOutputDirectory(cwd), 'graphify-out', 'graph.json') }
  private projectOutputDirectory(cwd: string): string { return join(this.rootDirectory, 'projects', projectIdFor(cwd)) }

  private readManifest(): Promise<RuntimeManifest | undefined> { return readRuntimeManifest(this.runtimeDirectory(), graphifyManifest) }

  private ensurePrivateDirectory(directory: string): Promise<void> { return ensurePrivateRuntimeDirectory(directory, 'Graphify') }

  private findUv(): string | undefined {
    const executable = platform() === 'win32' ? 'uv.exe' : 'uv'
    const privateUv = join(this.rootDirectory, 'tools', executable)
    if (existsSync(privateUv)) return privateUv
    return undefined
  }

  private uvArchive(): UvArchive | undefined {
    const support = graphifyPlatformSupport()
    if (!support.supported) return undefined
    return UV_ARCHIVES[support.id]
    /* c8 ignore next: kept as an explicit description of Linux target choice. */
    /*
    const report = process.report?.getReport() as { readonly header?: { readonly glibcVersionRuntime?: unknown } } | undefined
    const header = report?.header
    const libc = typeof header?.glibcVersionRuntime === 'string' && header.glibcVersionRuntime !== '' ? 'gnu' : 'musl'
    return UV_ARCHIVES[`linux-${architecture}-${libc}`]
    */
  }

  private async ensureUv(): Promise<string> {
    const existing = this.findUv()
    if (existing !== undefined) return existing
    const archive = this.uvArchive()
    if (archive === undefined) throw new Error('当前 OS/CPU/libc 组合没有经过验证的官方 uv 平台包。')
    const tools = join(this.rootDirectory, 'tools')
    await this.ensurePrivateDirectory(tools)
    const executable = platform() === 'win32' ? 'uv.exe' : 'uv'
    const target = join(tools, executable)
    const staged = `${target}.${randomUUID()}`
    const archivePath = join(tools, `.uv-archive-${randomUUID()}`)
    await downloadVerifiedAsset({ url: archive.url, digest: archive.digest, maxBytes: MAX_UV_ARCHIVE_BYTES, label: '官方 uv 平台包', destination: archivePath })
    try {
      // Both extractors scan the archive by name, so they still need its bytes;
      // the streamed download only spares the Host the peak copy of a transfer.
      const archiveBytes = await readFile(archivePath)
      const binary = archive.format === 'zip' ? extractZipExecutable(archiveBytes, executable) : extractTarExecutable(archiveBytes, executable)
      await writeFile(staged, binary, { mode: 0o700 })
      await rename(staged, target)
    } finally {
      await rm(archivePath, { force: true })
    }
    return target
  }

  private graphifyEnvironment(outputDirectory: string): NodeJS.ProcessEnv {
    return childProcessEnvironment({
      GRAPHIFY_OUT: join(outputDirectory, 'graphify-out'),
      GRAPHIFY_QUERY_LOG_DISABLE: '1',
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      UV_CACHE_DIR: join(this.rootDirectory, 'uv-cache'),
      UV_PYTHON_INSTALL_DIR: join(this.rootDirectory, 'python'),
    })
  }
}

/** A Graphify runtime directory is trusted only while its manifest still names
 *  the pinned version, wheel digest, and install mode. */
function graphifyManifest(value: Record<string, unknown>): RuntimeManifest | undefined {
  if (typeof value.version !== 'string' || typeof value.wheelDigest !== 'string' || typeof value.pythonRelativePath !== 'string' || typeof value.installedAt !== 'number' || (value.installMode !== 'managed-uv-python' && value.installMode !== 'existing-python')) return undefined
  return value as RuntimeManifest
}

/** Host environment entries inherited by plugin-owned child processes; every other entry is dropped. */
const CHILD_ENVIRONMENT_KEYS = [
  'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'HOME', 'USERPROFILE', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'TERM', 'NO_COLOR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
] as const

/** Explicit allowlist for child-process environments so host credentials and ambient state never leak to workers. */
export function childProcessEnvironment(overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const inherited: Record<string, string> = {}
  for (const key of CHILD_ENVIRONMENT_KEYS) {
    const value = process.env[key]
    if (value !== undefined && value !== '') inherited[key] = value
  }
  return { ...inherited, ...overrides }
}

function defaultGraphifyDirectory(): string {
  const home = freeCodeGoDataHome()
  return join(home, 'freecodego', 'engineering', 'graphify')
}

/** Stable per-workspace identity shared by every plugin-owned runtime (graphify,
 *  codegraph, memory); exported so those runtimes cannot drift apart. */
export function projectIdFor(cwd: string): string {
  const workspace = resolve(cwd)
  // Windows paths are case-insensitive; the whole identity is lowercased so a
  // differently cased cwd still maps to the same project.
  const identity = gitRemoteFor(workspace) ?? (process.platform === 'win32' ? normalize(workspace).replaceAll('\\', '/').toLowerCase() : normalize(workspace).replaceAll('\\', '/'))
  return createHash('sha256').update(identity).digest('hex').slice(0, 24)
}

function gitRemoteFor(cwd: string): string | undefined {
  // Walk upward so a repository subdirectory or worktree resolves to the same
  // identity as the repository root (see engineering-memory.ts).
  let directory = resolve(cwd)
  for (;;) {
    try {
      const config = readFileSync(join(directory, '.git', 'config'), 'utf8')
      const match = /\[remote\s+"origin"\][\s\S]*?\n\s*url\s*=\s*([^\n\r]+)/i.exec(config)
      const value = match?.[1]?.trim().toLowerCase().replace(/\.git$/, '')
      if (value !== undefined && value !== '') return value
    } catch {
      // Not a git config at this level; keep walking.
    }
    try {
      if (lstatSync(join(directory, '.git')).isFile()) {
        const parent = gitRemoteFor(dirname(directory))
        if (parent !== undefined) return parent
      }
    } catch { /* no .git entry here */ }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

function pythonPathForVenv(venvDirectory: string): string { return platform() === 'win32' ? join(venvDirectory, 'Scripts', 'python.exe') : join(venvDirectory, 'bin', 'python') }
function relativePythonPath(): string { return platform() === 'win32' ? join('venv', 'Scripts', 'python.exe') : join('venv', 'bin', 'python') }

function detectPythonExecutable(): string | undefined {
  const names = platform() === 'win32' ? ['python.exe', 'python3.exe', 'py.exe'] : ['python3', 'python']
  const entries = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').map(entry => entry.trim()).filter(Boolean)
  for (const directory of entries) {
    for (const name of names) {
      const candidate = resolve(directory, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

async function validateExistingPython(pythonPath: string, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const result = await runProcess(pythonPath, ['--version'], { cwd, timeout: QUERY_TIMEOUT_MS, env })
  const match = /Python\s+(\d+)\.(\d+)/i.exec(result.output)
  if (result.exitCode !== 0 || match === null) throw new Error('无法识别所选 Python 的版本，请选择 Python 3.10 或更高版本。')
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major < 3 || (major === 3 && minor < 10)) throw new Error(`所选 Python ${major}.${minor} 版本过低，需要 Python 3.10 或更高版本。`)
}

async function downloadVerifiedWheel(destination: string): Promise<void> {
  await downloadVerifiedAsset({ url: GRAPHIFY_WHEEL_URL, digest: GRAPHIFY_WHEEL_SHA256, maxBytes: MAX_WHEEL_BYTES, label: '官方 Graphify Wheel', destination })
}

/** Extract only the official uv executable from its signed, digest-pinned release archive. */
function extractZipExecutable(archive: Buffer, executable: string): Buffer {
  const endSignature = 0x06054b50
  let end = -1
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset -= 1) {
    if (archive.readUInt32LE(offset) === endSignature) { end = offset; break }
  }
  if (end < 0) throw new Error('官方 uv ZIP 归档格式无效。')
  const entries = archive.readUInt16LE(end + 10)
  let offset = archive.readUInt32LE(end + 16)
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) throw new Error('官方 uv ZIP 中央目录无效。')
    const method = archive.readUInt16LE(offset + 10)
    const compressedSize = archive.readUInt32LE(offset + 20)
    const uncompressedSize = archive.readUInt32LE(offset + 24)
    const nameLength = archive.readUInt16LE(offset + 28)
    const extraLength = archive.readUInt16LE(offset + 30)
    const commentLength = archive.readUInt16LE(offset + 32)
    const localOffset = archive.readUInt32LE(offset + 42)
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    if (name === executable || name.endsWith(`/${executable}`)) {
      if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('官方 uv ZIP 本地条目无效。')
      const localNameLength = archive.readUInt16LE(localOffset + 26)
      const localExtraLength = archive.readUInt16LE(localOffset + 28)
      const contentStart = localOffset + 30 + localNameLength + localExtraLength
      const contentEnd = contentStart + compressedSize
      if (contentEnd > archive.length || uncompressedSize > MAX_UV_ARCHIVE_BYTES) throw new Error('官方 uv ZIP 可执行文件范围无效。')
      const compressed = archive.subarray(contentStart, contentEnd)
      const extracted = method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed) : undefined
      if (extracted === undefined || extracted.byteLength !== uncompressedSize) throw new Error('官方 uv ZIP 可执行文件解压失败。')
      return extracted
    }
    offset += 46 + nameLength + extraLength + commentLength
  }
  throw new Error('官方 uv ZIP 未包含预期可执行文件。')
}

function extractTarExecutable(archive: Buffer, executable: string): Buffer {
  const tar = gunzipSync(archive)
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const name = readTarString(header.subarray(0, 100))
    const prefix = readTarString(header.subarray(345, 500))
    const path = prefix === '' ? name : `${prefix}/${name}`
    const size = readTarOctal(header.subarray(124, 136))
    const type = header[156]
    const contentStart = offset + 512
    const contentEnd = contentStart + size
    if (size < 0 || contentEnd > tar.length) throw new Error('官方 uv TAR 归档条目无效。')
    if ((type === 0 || type === 48) && (path === executable || path.endsWith(`/${executable}`))) return Buffer.from(tar.subarray(contentStart, contentEnd))
    offset = contentStart + Math.ceil(size / 512) * 512
  }
  throw new Error('官方 uv TAR 未包含预期可执行文件。')
}

function readTarString(value: Buffer): string {
  const end = value.indexOf(0)
  return value.subarray(0, end < 0 ? value.length : end).toString('utf8')
}

function readTarOctal(value: Buffer): number {
  const text = readTarString(value).trim().replace(/\0/g, '')
  const parsed = Number.parseInt(text === '' ? '0' : text, 8)
  return Number.isSafeInteger(parsed) ? parsed : -1
}

function graphifyQueryArguments(command: 'query' | 'explain' | 'path' | 'affected' | 'god-nodes', values: readonly string[], graphPath: string, depth: number | undefined, budget: number | undefined): readonly string[] {
  if (command === 'god-nodes') return ['god-nodes', '--graph', graphPath, '--json', ...(budget === undefined ? [] : ['--top', String(clamp(budget, 1, 50))])]
  if (command === 'path') {
    if (values.length !== 2) throw new Error('Graphify 路径查询需要两个节点名称。')
    return ['path', values[0]!, values[1]!, '--graph', graphPath]
  }
  if (values.length !== 1) throw new Error('Graphify 查询需要一个文本或节点名称。')
  if (command === 'query') return ['query', values[0]!, '--graph', graphPath, '--budget', String(clamp(budget ?? 2_000, 100, 8_000))]
  if (command === 'explain') return ['explain', values[0]!, '--graph', graphPath]
  return ['affected', values[0]!, '--graph', graphPath, '--depth', String(clamp(depth ?? 2, 1, 5))]
}

/** Spawn one plugin-owned child process with an allowlisted environment,
 *  bounded output, a hard timeout, and whole-process-tree cancellation.
 *  Exported so sibling runtime managers reuse this audited path instead of
 *  growing a second subprocess implementation. */
export async function runProcess(command: string, args: readonly string[], input: { readonly cwd: string; readonly timeout: number; readonly env: NodeJS.ProcessEnv; readonly signal?: AbortSignal }): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    let output = ''
    let settled = false
    let timedOut = false
    const child = spawn(command, args, { cwd: input.cwd, env: input.env, shell: false, windowsHide: true, detached: platform() !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    const append = (chunk: Buffer): void => { if (output.length < OUTPUT_LIMIT) output += chunk.toString('utf8').slice(0, OUTPUT_LIMIT - output.length) }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const timeout = setTimeout(() => {
      timedOut = true
      terminateProcessTree(child)
      settle(new Error('Graphify 子进程超时。'))
    }, input.timeout)
    const cancel = (): void => {
      terminateProcessTree(child)
      settle(new Error('Graphify 子进程已取消。'))
    }
    const settle = (value: ProcessResult | Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      input.signal?.removeEventListener('abort', cancel)
      if (value instanceof Error) reject(value)
      else resolveResult(value)
    }
    if (input.signal?.aborted) cancel()
    else input.signal?.addEventListener('abort', cancel, { once: true })
    child.once('error', (error) => { settle(error) })
    child.once('close', (code) => { if (!timedOut) settle({ exitCode: code ?? -1, output: output.trim() }) })
  })
}

export function linkedController(signal: AbortSignal | undefined): AbortController {
  const controller = new AbortController()
  if (signal === undefined) return controller
  const abort = (): void => { controller.abort(signal.reason) }
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  return controller
}

function stringField(value: Record<string, unknown>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const candidate = value[name]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim().slice(0, 1_000)
  }
  return undefined
}

function terminateProcessTree(child: ChildProcess): void {
  if (platform() === 'win32') {
    if (child.pid !== undefined) {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
      killer.once('error', () => { child.kill() })
    } else child.kill()
    return
  }
  if (child.pid === undefined) { child.kill(); return }
  try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
  setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') } }, 2_000).unref()
}

function clamp(value: number, min: number, max: number): number { return Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : min }
