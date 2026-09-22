/**
 * Plugin-owned launcher for the official self-contained CodeGraph runtime.
 *
 * CodeGraph ships one archive per platform that CONTAINS its own Node runtime,
 * so this engine needs no Python, no `uv`, and no wheel: download, verify the
 * published SHA-256, unpack, run. That is the whole difference from the sibling
 * Graphify engine, which has to build a private Python environment first.
 *
 * Two behaviours are deliberately pinned here:
 *
 *  - The index lives in the WORKSPACE (`<workspace>/.codegraph-freecodego`).
 *    CodeGraph resolves its data directory as a single path segment under the
 *    project root and rejects anything else, so unlike Graphify this engine
 *    cannot keep its artifacts under DSH_HOME. The name is plugin-specific so a
 *    user's own `codegraph init` (which owns `.codegraph`) never collides with
 *    ours, and CodeGraph skips every `.codegraph-*` sibling while indexing.
 *  - No daemon, no watcher, no telemetry. Queries read the index on disk and are
 *    one-shot, so freshness is the caller's job (`sync` on the paths that
 *    changed) instead of a background process the plugin cannot audit.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { platform } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { freeCodeGoDataHome } from './data-home.ts'
import { childProcessEnvironment, linkedController, projectIdFor, runProcess } from './engineering-graphify.ts'
import { BuildTracker, downloadVerifiedAsset, ensurePrivateDirectory as ensurePrivateRuntimeDirectory, readRuntimeManifest, replaceVerifiedRuntimeDirectory, writeRuntimeManifest } from './engineering-runtime-store.ts'
import type { FreeCodeGoEngineeringCodeGraphProjectStatus, FreeCodeGoEngineeringCodeGraphRuntimePackage, FreeCodeGoEngineeringCodeGraphRuntimeStatus } from './types.ts'

/**
 * The CodeGraph release this plugin installs and verifies against.
 */
export const CODEGRAPH_VERSION = '1.6.0'
/** Per-workspace index directory CodeGraph creates inside the workspace root. */
export const CODEGRAPH_DIR_NAME = '.codegraph-freecodego'
const RELEASE_TAG = `v${CODEGRAPH_VERSION}`
const RELEASE_BASE = `https://github.com/colbymchenry/codegraph/releases/download/${RELEASE_TAG}`
const INSTALL_TIMEOUT_MS = 10 * 60_000
const BUILD_TIMEOUT_MS = 15 * 60_000
const QUERY_TIMEOUT_MS = 30_000
/** Largest published archive is ~62 MB; the cap only bounds a hostile response. */
const MAX_BUNDLE_BYTES = 128 * 1024 * 1024

type BundleArchive = { readonly asset: string; readonly digest: string; readonly format: 'zip' | 'tar.gz' }

type RuntimeManifest = {
  readonly version: string
  readonly target: string
  readonly bundleDigest: string
  readonly installedAt: number
}

/**
 * The release's own per-platform digests, read from the published assets of
 * `v1.6.0`. Every archive is verified against its row before it is unpacked, so
 * a swapped or truncated download can never become a runtime.
 */
const BUNDLE_ARCHIVES: Readonly<Record<string, BundleArchive>> = {
  'win32-x64': { format: 'zip', asset: 'codegraph-win32-x64.zip', digest: 'cd76c3c3391f2d40abef12b142151950b6d77abc2d8429e648f89eaa90f5b68a' },
  'win32-arm64': { format: 'zip', asset: 'codegraph-win32-arm64.zip', digest: '3ca980010bd718a6b5e75be1145806ae6491afb1a59a2cec6cee4bf5c39f1b3a' },
  'darwin-x64': { format: 'tar.gz', asset: 'codegraph-darwin-x64.tar.gz', digest: 'cb86a2b62ee676b62a56bf8423600e7d867e752e57f323cdc98c0f6236efd908' },
  'darwin-arm64': { format: 'tar.gz', asset: 'codegraph-darwin-arm64.tar.gz', digest: '1c73033512d55f67be04717e81532e8beaf7be6fb8531f51a179fa23064ad480' },
  'linux-x64': { format: 'tar.gz', asset: 'codegraph-linux-x64.tar.gz', digest: 'de3391f79ed42622d937e6cd5b7642a7ea8bb7d1473607e80b879ba73ef216b0' },
  'linux-arm64': { format: 'tar.gz', asset: 'codegraph-linux-arm64.tar.gz', digest: '6dc935a7b8f1a61e688a578b98ea34680eb2e36d7b91db079d64f4011f1a668f' },
}

/**
 * Pure platform resolver exercised in CI for every supported desktop target.
 * @param os - the operating system id; defaults to the running host.
 * @param architecture - the CPU architecture; defaults to the running host.
 * @param libc - the Linux libc, when the caller knows it.
 * @returns the platform id, whether it is supported, and the reason.
 */
export function codegraphPlatformSupport(os = platform(), architecture = process.arch, libc?: 'gnu' | 'musl'): { readonly id: string; readonly supported: boolean; readonly detail: string } {
  const arch = architecture === 'arm64' ? 'arm64' : architecture === 'x64' ? 'x64' : undefined
  const id = `${os}-${arch ?? architecture}`
  if (os === 'linux') {
    const resolvedLibc = libc ?? ((process.report?.getReport() as { readonly header?: { readonly glibcVersionRuntime?: unknown } } | undefined)?.header?.glibcVersionRuntime ? 'gnu' : 'musl')
    // The official Linux bundles are built against glibc and ship a glibc-linked
    // Node runtime, so a musl host (Alpine and friends) cannot run them.
    if (resolvedLibc === 'musl') return { id, supported: false, detail: 'CodeGraph 官方 Linux 包依赖 glibc，当前 musl 系统不受支持。' }
  }
  return BUNDLE_ARCHIVES[id] === undefined
    ? { id, supported: false, detail: '当前 OS/CPU 组合没有经过验证的 CodeGraph 官方平台包。' }
    : { id, supported: true, detail: '已匹配官方自包含平台包（内置 Node 运行时，无需 Python）。' }
}

/**
 * The one installation source this engine offers. Unlike Graphify there is no
 * second (bring-your-own-interpreter) mode, and no platform matrix to choose
 * from: the row describes THIS platform and carries the resolver's explanation
 * when there is no verified bundle for it (musl Linux, an unknown CPU).
 * @returns the engineering Code Graph Runtime Package rows, in backend order.
 * @param os - the operating system id; defaults to the running host.
 * @param architecture - the CPU architecture; defaults to the running host.
 * @param libc - the Linux libc, when the caller knows it.
 */
export function codegraphPlatformPackages(os = platform(), architecture = process.arch, libc?: 'gnu' | 'musl'): readonly FreeCodeGoEngineeringCodeGraphRuntimePackage[] {
  const active = codegraphPlatformSupport(os, architecture, libc)
  return [{
    id: 'managed-bundle' as const,
    label: `CodeGraph ${CODEGRAPH_VERSION}（${active.id}）`,
    detail: active.detail,
    compatible: active.supported,
    requiresPath: false,
  }]
}

/**
 * The verified archive for a platform, or `undefined` when none is published.
 * @param os - the operating system id; defaults to the running host.
 * @param architecture - the CPU architecture; defaults to the running host.
 * @param libc - the Linux libc, when the caller knows it.
 * @returns the archive row, or `undefined` for an unsupported platform.
 */
export function codegraphArchive(os = platform(), architecture = process.arch, libc?: 'gnu' | 'musl'): BundleArchive | undefined {
  const support = codegraphPlatformSupport(os, architecture, libc)
  return support.supported ? BUNDLE_ARCHIVES[support.id] : undefined
}

/** `tar` is the only external tool this engine uses. bsdtar (Windows 10+) reads
 *  both `.zip` and `.tar.gz`, and the archive is digest-verified before unpacking
/**
 * so the unpacker is never trusted with unverified input.
 * @param archivePath - the verified archive on disk.
 * @param destination - the directory the archive is unpacked into.
 * @param format - the archive format.
 * @returns the arguments that unpack the archive into the destination.
 */
export function codegraphExtractArguments(archivePath: string, destination: string, format: BundleArchive['format']): readonly string[] {
  return format === 'zip'
    ? ['-xf', archivePath, '-C', destination, '--strip-components=1']
    : ['-xzf', archivePath, '-C', destination, '--strip-components=1']
}

/**
 * How the plugin launches one installed bundle. Windows must NOT go through the
 * bundle's `.cmd` launcher: modern Node refuses to spawn `.cmd`/`.bat` (EINVAL,
 * the CVE-2024-27980 hardening), so it runs the bundled `node.exe` against the
 * app entry directly. Both paths keep tree-sitter's WASM `--liftoff-only`
 * (Node's turboshaft tier OOMs compiling grammars) and mute `node:sqlite`'s
 * per-thread experimental warning, which would otherwise shred query output.
 * @param bundleDirectory - the installed bundle directory.
 * @param args - the CodeGraph CLI arguments.
 * @param os - the operating system id; defaults to the running host.
 * @returns the command and full argument list to spawn.
 */
export function codegraphLaunch(bundleDirectory: string, args: readonly string[], os = platform()): { readonly command: string; readonly args: readonly string[] } {
  if (os === 'win32') {
    return {
      command: join(bundleDirectory, 'node.exe'),
      args: ['--liftoff-only', '--disable-warning=ExperimentalWarning', join(bundleDirectory, 'lib', 'dist', 'bin', 'codegraph.js'), ...args],
    }
  }
  return { command: join(bundleDirectory, 'bin', 'codegraph'), args: [...args] }
}

/**
 * Environment for every plugin-owned CodeGraph process. `childProcessEnvironment`
 * drops host credentials; the CodeGraph-specific entries make the runtime local
 * and quiet: no anonymous telemetry, no background daemon, no self-download from
 * the network, and the plugin-specific index directory name.
 * @param overrides - entries merged over the CodeGraph defaults.
 * @returns the child-process environment.
 */
export function codegraphEnvironment(overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return childProcessEnvironment({
    CODEGRAPH_DIR: CODEGRAPH_DIR_NAME,
    CODEGRAPH_NO_DAEMON: '1',
    CODEGRAPH_NO_DOWNLOAD: '1',
    CODEGRAPH_TELEMETRY: '0',
    DO_NOT_TRACK: '1',
    ...overrides,
  })
}

/**
 * The audited read-only CodeGraph query commands.
 */
export type CodeGraphQueryCommand = 'search' | 'explore' | 'symbol' | 'path' | 'impact'

/**
 * Fixed argument shapes for the audited read-only CodeGraph CLI surface.
 * @param command - the query command to build arguments for.
 * @param values - the command's text or node names.
 * @param workspace - the workspace the index belongs to.
 * @param depth - the traversal depth, for the impact command.
 * @param budget - the row or file budget, for the result-bearing commands.
 * @returns the fixed argument list.
 */
export function codegraphQueryArguments(command: CodeGraphQueryCommand, values: readonly string[], workspace: string, depth: number | undefined, budget: number | undefined): readonly string[] {
  if (command === 'explore') {
    const query = values.join(' ')
    if (query === '') throw new Error('CodeGraph 探索查询需要一个查询文本。')
    // A single argument: the CLI's variadic query is joined by commander, and a
    // bare `->` token would otherwise be parsed as an unknown option.
    return ['explore', query, '--path', workspace, '--max-files', String(bounded(budget ?? 6, 1, 20))]
  }
  if (command === 'path') {
    if (values.length !== 2) throw new Error('CodeGraph 路径查询需要两个节点名称。')
    // CodeGraph has no `path` command; its explore flow syntax answers exactly
    // the same question and follows calls the graph recorded.
    return ['explore', `${values[0]} -> ${values[1]}`, '--path', workspace, '--max-files', String(bounded(budget ?? 8, 1, 20))]
  }
  if (values.length !== 1) throw new Error('CodeGraph 查询需要一个文本或节点名称。')
  if (command === 'search') return ['query', values[0]!, '--path', workspace, '--limit', String(bounded(budget ?? 10, 1, 50)), '--json']
  if (command === 'symbol') return ['node', values[0]!, '--path', workspace]
  return ['impact', values[0]!, '--path', workspace, '--depth', String(bounded(depth ?? 2, 1, 5)), '--json']
}

/** Executes only fixed CodeGraph arguments; the runtime lives under DSH_HOME and the index under the workspace. */
export class CodeGraphRuntimeManager {
  private readonly rootDirectory: string
  private installTask: Promise<FreeCodeGoEngineeringCodeGraphRuntimeStatus> | undefined
  private readonly builds = new BuildTracker()

  constructor(rootDirectory = defaultCodeGraphDirectory()) {
    this.rootDirectory = resolve(rootDirectory)
  }

/**
 * Report the installed runtime's state and version.
 * @returns the runtime status.
 */
  async status(): Promise<FreeCodeGoEngineeringCodeGraphRuntimeStatus> {
    if (this.installTask !== undefined) return { state: 'installing', installed: false, version: CODEGRAPH_VERSION, runtimeDirectory: this.runtimeDirectory() }
    const manifest = await this.readManifest()
    const binaryPath = codegraphLaunch(this.runtimeDirectory(), ['version']).command
    if (manifest === undefined || !existsSync(binaryPath)) {
      return {
        state: 'unavailable', installed: false, version: CODEGRAPH_VERSION, runtimeDirectory: this.runtimeDirectory(),
        reason: manifest === undefined ? '尚未安装官方 CodeGraph Runtime。' : 'CodeGraph Runtime 清单或自带运行时缺失，请重新安装。',
      }
    }
    const archive = codegraphArchive()
    if (manifest.version !== CODEGRAPH_VERSION || manifest.target !== codegraphPlatformSupport().id || manifest.bundleDigest !== archive?.digest) {
      return { state: 'error', installed: false, version: CODEGRAPH_VERSION, runtimeDirectory: this.runtimeDirectory(), reason: '已安装 CodeGraph Runtime 与当前经过验证的版本或校验值不一致。' }
    }
    return { state: 'ready', installed: true, version: CODEGRAPH_VERSION, runtimeDirectory: this.runtimeDirectory(), binaryPath, bundleDigest: manifest.bundleDigest }
  }

/**
 * List the installation sources this engine offers.
 * @returns the runtime package rows.
 */
  async packages(): Promise<readonly FreeCodeGoEngineeringCodeGraphRuntimePackage[]> {
    return codegraphPlatformPackages()
  }

/**
 * Install the official bundle, deduplicating concurrent calls.
 * @returns the runtime status after the install.
 */
  async install(): Promise<FreeCodeGoEngineeringCodeGraphRuntimeStatus> {
    if (this.installTask !== undefined) return this.installTask
    const task = this.installOfficialBundle()
    this.installTask = task
    try { return await task } finally { this.installTask = undefined }
  }

/**
 * Delete the installed runtime and report the resulting status.
 * @returns the runtime status after removal.
 */
  async remove(): Promise<FreeCodeGoEngineeringCodeGraphRuntimeStatus> {
    if (this.installTask !== undefined) throw new Error('CodeGraph Runtime 安装仍在进行，无法删除。')
    await rm(this.runtimeDirectory(), { recursive: true, force: true })
    return this.status()
  }

/**
 * Report whether the workspace index exists and how fresh it is.
 * @param cwd - the workspace to inspect.
 * @returns the workspace's CodeGraph index status.
 */
  async projectStatus(cwd: string): Promise<FreeCodeGoEngineeringCodeGraphProjectStatus> {
    const workspace = resolve(cwd)
    const projectId = projectIdFor(workspace)
    const indexPath = this.indexPath(workspace)
    if (this.builds.isBuilding(projectId)) return { state: 'building', projectId, indexPath }
    const runtime = await this.status()
    if (!runtime.installed) return { state: 'unavailable', projectId, indexPath, reason: runtime.reason ?? 'CodeGraph Runtime 未安装。' }
    try {
      const info = await stat(indexPath)
      return { state: 'ready', projectId, indexPath, builtAt: info.mtimeMs, indexBytes: info.size }
    } catch {
      return { state: 'missing', projectId, indexPath, reason: '当前工作区尚未构建 CodeGraph 索引。' }
    }
  }

  /**
   * Build or refresh the workspace index. A workspace with no index is
   * initialized (`init` also builds the full graph in the same step); an
   * existing index is refreshed incrementally unless `force` asks for the full
   * rebuild, because `codegraph index` recreates the database from scratch.
   * @returns the engineering Code Graph Project Status.
   * @param cwd - working directory the command runs in.
 * @param options - whether to force a full rebuild and a signal to cancel with.
   */
  async build(cwd: string, options: { readonly force?: boolean; readonly signal?: AbortSignal } = {}): Promise<FreeCodeGoEngineeringCodeGraphProjectStatus> {
    const workspace = resolve(cwd)
    const workspaceInfo = await stat(workspace).catch(() => undefined)
    if (workspaceInfo?.isDirectory() !== true) throw new Error('CodeGraph 工作区路径不存在或不是目录。')
    const runtime = await this.status()
    if (!runtime.installed) throw new Error(runtime.reason ?? 'CodeGraph Runtime 未安装。')
    const projectId = projectIdFor(workspace)
    // Claim the workspace before any await so two builds cannot race on the
    // same index directory.
    this.builds.claim(projectId, '该工作区的 CodeGraph 索引已在进行。')
    const controller = linkedController(options.signal)
    this.builds.attach(projectId, controller)
    try {
      const initialized = existsSync(this.indexPath(workspace))
      const args = !initialized
        ? ['init', workspace, '--yes']
        : options.force === true
          ? ['index', workspace, '--quiet']
          : ['sync', workspace, '--quiet']
      const result = await this.run(workspace, args, { timeout: BUILD_TIMEOUT_MS, signal: controller.signal })
      if (result.exitCode !== 0) throw new Error(`CodeGraph 索引失败：${result.output || `退出码 ${result.exitCode}`}`)
    } finally {
      this.builds.release(projectId)
    }
    // Read the status only after the claim is released: `projectStatus` answers
    // `building` straight from the claim, so a build that reports its own status
    // while still holding it tells the caller it never finished.
    return this.projectStatus(workspace)
  }

  /** Incrementally absorb file changes; cheap enough to run after edits. 
   * @param signal - aborts the request when the caller cancels.
   * @returns the engineering Code Graph Project Status.
   * @param cwd - working directory the command runs in.
   */
  async sync(cwd: string, signal?: AbortSignal): Promise<FreeCodeGoEngineeringCodeGraphProjectStatus> {
    const workspace = resolve(cwd)
    const project = await this.projectStatus(workspace)
    if (project.state !== 'ready') throw new Error(project.reason ?? '当前工作区尚未构建 CodeGraph 索引。')
    return this.build(workspace, signal === undefined ? {} : { signal })
  }

  /** Abort the plugin-owned CodeGraph process tree for the current workspace. 
   * @param cwd - working directory the command runs in.
 * @returns whether a running build was cancelled.
   */
  cancel(cwd: string): { readonly cancelled: boolean } {
    return this.builds.cancel(projectIdFor(cwd))
  }

  /**
   * Remove only the workspace's CodeGraph index directory. This is the single
   * path the plugin deletes INSIDE a user workspace, so it must be exactly the
   * plugin's own data directory directly under the workspace root — never a
   * symlink, never a parent, never a `.codegraph` a user created themselves.
   * @returns the engineering Code Graph Project Status.
   * @param cwd - working directory the command runs in.
   */
  async clearProject(cwd: string): Promise<FreeCodeGoEngineeringCodeGraphProjectStatus> {
    const workspace = resolve(cwd)
    if (this.builds.isBuilding(projectIdFor(workspace))) throw new Error('CodeGraph 索引进行中，无法清空项目索引。')
    const target = join(workspace, CODEGRAPH_DIR_NAME)
    if (dirname(target) !== workspace || basename(target) !== CODEGRAPH_DIR_NAME) throw new Error('CodeGraph 项目目录不在工作区根目录内。')
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error('CodeGraph 项目目录不能是符号链接。')
    await rm(target, { recursive: true, force: true })
    return this.projectStatus(workspace)
  }

  /** Run a read-only CodeGraph query against the workspace's plugin-owned index. 
   * @param cwd - working directory the command runs in.
 * @param input - the command, its values, and optional depth and budget.
 * @returns the query output and the workspace status it ran against.
   */
  async query(cwd: string, input: { readonly command: CodeGraphQueryCommand; readonly values?: readonly string[]; readonly depth?: number; readonly budget?: number }): Promise<{ readonly output: string; readonly project: FreeCodeGoEngineeringCodeGraphProjectStatus }> {
    const workspace = resolve(cwd)
    const project = await this.projectStatus(workspace)
    if (project.state !== 'ready') throw new Error(project.reason ?? '当前工作区的 CodeGraph 索引不可用。')
    const runtime = await this.status()
    if (!runtime.installed) throw new Error(runtime.reason ?? 'CodeGraph Runtime 未安装。')
    const values = (input.values ?? []).map(value => value.trim()).filter(value => value !== '')
    const args = codegraphQueryArguments(input.command, values, workspace, input.depth, input.budget)
    const result = await this.run(workspace, args, { timeout: QUERY_TIMEOUT_MS })
    if (result.exitCode !== 0) throw new Error(`CodeGraph 查询失败：${result.output || `退出码 ${result.exitCode}`}`)
    return { output: result.output, project }
  }

  private async installOfficialBundle(): Promise<FreeCodeGoEngineeringCodeGraphRuntimeStatus> {
    const archive = codegraphArchive()
    if (archive === undefined) throw new Error('当前系统没有经过验证的 CodeGraph 官方平台包。')
    await ensurePrivateRuntimeDirectory(this.rootDirectory, 'CodeGraph')
    const staging = join(this.rootDirectory, `.install-${randomUUID()}`)
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true, mode: 0o700 })
    try {
      const archivePath = join(staging, archive.asset)
      await downloadVerifiedAsset({
        url: `${RELEASE_BASE}/${archive.asset}`, digest: archive.digest, maxBytes: MAX_BUNDLE_BYTES,
        label: 'CodeGraph 官方平台包', destination: archivePath,
      })
      const extract = await runProcess('tar', codegraphExtractArguments(archivePath, staging, archive.format), { cwd: staging, timeout: INSTALL_TIMEOUT_MS, env: codegraphEnvironment() })
      if (extract.exitCode !== 0) throw new Error(`CodeGraph 平台包解压失败：${extract.output || `退出码 ${extract.exitCode}`}`)
      await rm(archivePath, { force: true })
      const launch = codegraphLaunch(staging, ['version'])
      if (!existsSync(launch.command) || !existsSync(join(staging, 'lib'))) throw new Error('CodeGraph 平台包结构无效。')
      const check = await runProcess(launch.command, launch.args, { cwd: staging, timeout: QUERY_TIMEOUT_MS, env: codegraphEnvironment() })
      if (check.exitCode !== 0 || !new RegExp(`\\b${CODEGRAPH_VERSION.replaceAll('.', '\\.')}\\b`).test(check.output)) throw new Error(`CodeGraph Runtime 版本验证失败：${check.output || `退出码 ${check.exitCode}`}`)
      const manifest: RuntimeManifest = {
        version: CODEGRAPH_VERSION,
        target: codegraphPlatformSupport().id,
        bundleDigest: archive.digest,
        installedAt: Date.now(),
      }
      await writeRuntimeManifest(staging, manifest)
      // Verify again at the final path: the check above ran inside the staging
      // directory, and only this run proves the published runtime is intact
      // after the move. The previous bundle stays reachable until it does, so a
      // failed move restores the working install instead of deleting both.
      await replaceVerifiedRuntimeDirectory({
        staging,
        target: this.runtimeDirectory(),
        verify: async (published) => {
          const relocated = codegraphLaunch(published, ['version'])
          const relocatedCheck = await runProcess(relocated.command, relocated.args, { cwd: published, timeout: QUERY_TIMEOUT_MS, env: codegraphEnvironment() })
          if (relocatedCheck.exitCode !== 0 || !new RegExp(`\\b${CODEGRAPH_VERSION.replaceAll('.', '\\.')}\\b`).test(relocatedCheck.output)) {
            throw new Error(`CodeGraph Runtime 移动后的验证失败：${relocatedCheck.output || `退出码 ${relocatedCheck.exitCode}`}`)
          }
        },
      })
      return {
        state: 'ready', installed: true, version: CODEGRAPH_VERSION,
        runtimeDirectory: this.runtimeDirectory(), binaryPath: codegraphLaunch(this.runtimeDirectory(), ['version']).command, bundleDigest: archive.digest,
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
  }

  private async run(workspace: string, args: readonly string[], options: { readonly timeout: number; readonly signal?: AbortSignal }): Promise<{ readonly exitCode: number; readonly output: string }> {
    const launch = codegraphLaunch(this.runtimeDirectory(), args)
    return runProcess(launch.command, launch.args, {
      cwd: workspace, timeout: options.timeout, env: codegraphEnvironment(),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  }

  /** One private runtime per version AND platform target: a Windows install and
   *  a WSL install can share one DSH_HOME without overwriting each other. */
  private runtimeDirectory(): string { return join(this.rootDirectory, 'runtime', `codegraph-${CODEGRAPH_VERSION}-${codegraphPlatformSupport().id}`) }
  private indexPath(cwd: string): string { return join(resolve(cwd), CODEGRAPH_DIR_NAME, 'codegraph.db') }

  private readManifest(): Promise<RuntimeManifest | undefined> { return readRuntimeManifest(this.runtimeDirectory(), codegraphManifest) }
}

/** A CodeGraph runtime directory is trusted only while its manifest still names
 *  the pinned version, the platform target, and the verified bundle digest. */
function codegraphManifest(value: Record<string, unknown>): RuntimeManifest | undefined {
  if (typeof value.version !== 'string' || typeof value.target !== 'string' || typeof value.bundleDigest !== 'string' || typeof value.installedAt !== 'number') return undefined
  return value as RuntimeManifest
}

function defaultCodeGraphDirectory(): string {
  const home = freeCodeGoDataHome()
  return join(home, 'freecodego', 'engineering', 'codegraph')
}

function bounded(value: number, min: number, max: number): number { return Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : min }
