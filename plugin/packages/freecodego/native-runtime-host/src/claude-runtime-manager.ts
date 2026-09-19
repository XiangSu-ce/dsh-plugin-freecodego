import { createHash } from 'node:crypto'
import { mkdir, chmod, copyFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { currentRuntimePlatform, resolveContained } from './manifest.ts'
import { downloadRuntimeArchive, extractRuntimeArchive, preserveRuntimeArchive } from './runtime-download.ts'
import { claudeRuntimePackages } from './runtime-packages.ts'

const RUNTIME_PROTOCOL_ABI = 'freecodego-agent/1'
const markerName = 'claude-agent-sdk-runtime.json'

export interface ClaudeRuntimeStatus {
  readonly installed: boolean
  readonly platform: string
  readonly runtimeVersion?: string
  readonly artifactDigest?: string
  readonly sourceRevision?: string
  readonly path?: string
  readonly reason?: string
}

export interface ClaudeRuntimeIdentity {
  readonly protocolAbi: string
  readonly runtimeVersion: string
  readonly artifactDigest: string
  readonly sourceRevision: string
  readonly executablePath: string
}

export interface ClaudeRuntimePackage {
  readonly id: string
  readonly platform: string
  readonly label: string
  readonly runtimeVersion: string
  readonly sourceRevision: string
  readonly installDirectory: string
  readonly compatible: boolean
  readonly source: 'official'
  readonly downloadURL: string
}

type ClaudeRuntimeMarker = {
  readonly formatVersion: 1
  readonly engine: 'claude'
  readonly platform: string
  readonly protocolAbi: string
  readonly runtimeVersion: string
  readonly artifactDigest: string
  readonly sourceRevision: string
  readonly executablePath: string
}

/**
 * Tracks the installed official Claude Agent SDK CLI without copying the retired agent core.
 *
 * The runtime is the downloaded CLI binary plus the SDK that drives it in the
 * Host process. `engineManifestPath` is the driver's own `package.json`: its SDK
 * pin names the runtime version and its bytes are folded into the artifact
 * digest, so an SDK repin invalidates a durable plan made under the old one.
 */
export class ClaudeRuntimeManager {
  readonly rootDirectory: string
  private readonly engineManifestPath: string
  private operation: Promise<unknown> | undefined

  constructor(config: { readonly rootDirectory?: string; readonly engineManifestPath?: string } = {}) {
    const home = process.env.DSH_HOME?.trim() || join(process.env.USERPROFILE || process.env.HOME || process.cwd(), '.dsh')
    this.rootDirectory = resolve(config.rootDirectory || join(home, 'runtimes', 'claude'))
    this.engineManifestPath = resolve(
      config.engineManifestPath === undefined || config.engineManifestPath.trim() === ''
        ? defaultEngineManifestPath()
        : config.engineManifestPath,
    )
  }

  status(): ClaudeRuntimeStatus {
    const platform = currentRuntimePlatform()
    const marker = readMarker(join(this.rootDirectory, markerName))
    if (marker === undefined || !existsSync(join(this.rootDirectory, '.complete'))) {
      return { installed: false, platform, reason: 'CLAUDE_RUNTIME_NOT_INSTALLED' }
    }
    try {
      // The marker lives in a user-writable home, so its path is untrusted
      // input like any other: containment is checked where it is read, not only
      // where this plugin writes it.
      const executablePath = resolveContained(this.rootDirectory, marker.executablePath)
      if (!existsSync(executablePath)) return { installed: false, platform, reason: 'CLAUDE_RUNTIME_INCOMPLETE' }
      // A full identity would read and SHA-256 the entire CLI binary on every
      // call; the agent-engine-router polls this every 500ms, which pinned a
      // core for hashing tens to hundreds of MB. The install-time marker
      // already carries the digest, so this fast path checks only the cheap
      // protocol compatibility signal plus executable presence.
      if (
        marker.engine !== 'claude'
        || marker.platform !== platform
        || marker.protocolAbi !== RUNTIME_PROTOCOL_ABI
      ) {
        return { installed: false, platform, reason: 'CLAUDE_RUNTIME_UPDATE_REQUIRED' }
      }
      return {
        installed: true,
        platform,
        runtimeVersion: marker.runtimeVersion,
        artifactDigest: marker.artifactDigest,
        sourceRevision: marker.sourceRevision,
        path: this.rootDirectory,
      }
    } catch (error) {
      return { installed: false, platform, reason: error instanceof Error ? `CLAUDE_RUNTIME_INVALID:${error.message}` : 'CLAUDE_RUNTIME_INVALID' }
    }
  }

  async runtime(): Promise<ClaudeRuntimeIdentity> {
    const status = this.status()
    if (!status.installed) throw unavailable(status.reason)
    const marker = readMarker(join(this.rootDirectory, markerName))
    if (marker === undefined) throw unavailable('CLAUDE_RUNTIME_NOT_INSTALLED')
    return this.identity(resolveContained(this.rootDirectory, marker.executablePath))
  }

  packages(): readonly ClaudeRuntimePackage[] {
    const platform = currentRuntimePlatform()
    return claudeRuntimePackages.map(spec => ({
      id: spec.id,
      platform: spec.platform,
      label: spec.label,
      runtimeVersion: spec.runtimeVersion,
      sourceRevision: spec.sourceRevision,
      installDirectory: this.rootDirectory,
      compatible: spec.platform === platform,
      source: 'official',
      downloadURL: spec.downloadURL,
    }))
  }

  async install(packageID = currentClaudePackage().id): Promise<ClaudeRuntimeStatus> {
    return this.serialize(async () => {
      const platform = currentRuntimePlatform()
      const spec = claudeRuntimePackages.find(item => item.id === packageID)
      if (spec === undefined || spec.platform !== platform) throw new Error(`Claude package ${packageID} is not compatible with ${platform}`)
      const archive = await downloadRuntimeArchive(spec, join(this.rootDirectory, '.downloads'))
      const staging = `${this.rootDirectory}.extract-${process.pid}-${Date.now()}`
      const extractedPackage = await extractRuntimeArchive(archive, staging)
      const temporary = `${this.rootDirectory}.partial-${process.pid}-${Date.now()}`
      const backup = `${this.rootDirectory}.old-${process.pid}-${Date.now()}`
      try {
        await rm(temporary, { recursive: true, force: true })
        const executable = join(extractedPackage, platform.startsWith('win32-') ? 'claude.exe' : 'claude')
        if (!existsSync(executable)) throw new Error(`Claude package ${packageID} does not contain a ${platform} executable`)
        const installedExecutable = join(temporary, 'cli', platform.startsWith('win32-') ? 'claude.exe' : 'claude')
        await mkdir(dirname(installedExecutable), { recursive: true })
        await copyFile(executable, installedExecutable)
        await chmod(installedExecutable, 0o700)
        await preserveRuntimeArchive(archive, temporary)
        const identity = this.identity(installedExecutable)
        const marker: ClaudeRuntimeMarker = {
          formatVersion: 1,
          engine: 'claude',
          platform,
          protocolAbi: identity.protocolAbi,
          runtimeVersion: identity.runtimeVersion,
          artifactDigest: identity.artifactDigest,
          sourceRevision: identity.sourceRevision,
          executablePath: relative(temporary, installedExecutable).replaceAll('\\', '/'),
        }
        await writeFile(join(temporary, markerName), `${JSON.stringify(marker)}\n`, 'utf8')
        try { await rename(this.rootDirectory, backup) } catch (error) {
          if ((error as { code?: unknown }).code !== 'ENOENT') throw error
        }
        try {
          await mkdir(dirname(this.rootDirectory), { recursive: true })
          await writeFile(join(temporary, '.complete'), `${marker.sourceRevision}\n`, 'utf8')
          await rename(temporary, this.rootDirectory)
        } catch (error) {
          // The restore failure must not be swallowed: a silent failure leaves
          // the machine with NO runtime at all (root gone, backup stranded at
          // `.old-*`) while the caller believes the previous install survived.
          await rename(backup, this.rootDirectory).catch((restoreError: unknown) => {
            throw new Error(`Claude runtime install failed (${error instanceof Error ? error.message : String(error)}), and restoring the previous runtime also failed (${restoreError instanceof Error ? restoreError.message : String(restoreError)}); the backup remains at ${backup}`)
          })
          throw error
        }
        await rm(backup, { recursive: true, force: true }).catch(() => undefined)
        return this.status()
      } finally {
        // Staging cleanup is best-effort: on Windows an antivirus or search
        // indexer can hold the freshly extracted executable (EBUSY/EPERM, not
        // suppressed by force) and a throwing cleanup would override the
        // already-successful install result above.
        await rm(staging, { recursive: true, force: true }).catch(() => undefined)
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
      }
    })
  }

  async remove(): Promise<ClaudeRuntimeStatus> {
    return this.serialize(async () => {
      await rm(this.rootDirectory, { recursive: true, force: true })
      if (existsSync(this.rootDirectory)) throw new Error(`Claude runtime directory still exists after removal: ${this.rootDirectory}`)
      return this.status()
    })
  }

  private identity(executablePath: string): ClaudeRuntimeIdentity {
    // A missing driver manifest is a broken deployment, not a corrupt install:
    // say which path was expected instead of surfacing a bare ENOENT.
    if (!existsSync(this.engineManifestPath)) {
      throw new Error(`Claude Agent SDK driver manifest is missing: ${this.engineManifestPath}`)
    }
    const manifestSource = readFileSync(this.engineManifestPath)
    const manifest = JSON.parse(manifestSource.toString('utf8')) as { dependencies?: Record<string, unknown> }
    const sdkVersion = manifest.dependencies?.['@anthropic-ai/claude-agent-sdk']
    if (typeof sdkVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(sdkVersion)) {
      throw new Error('Claude Agent SDK driver dependency version is missing')
    }
    // The digest covers the CLI binary and the driver manifest that pins the SDK
    // used to drive it. The Host bundle that hosts the session is not hashed here;
    // that was equally true when this read a worker file instead.
    const digest = createHash('sha256').update(manifestSource).update('\0').update(readFileSync(executablePath)).digest('hex')
    return {
      protocolAbi: RUNTIME_PROTOCOL_ABI,
      runtimeVersion: `claude-agent-sdk-worker/${sdkVersion}`,
      artifactDigest: `sha256:${digest}`,
      sourceRevision: `npm:@anthropic-ai/claude-agent-sdk-${currentRuntimePlatform()}@${sdkVersion}`,
      executablePath,
    }
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operation ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(operation)
    this.operation = run
    try {
      return await run
    } finally {
      if (this.operation === run) this.operation = undefined
    }
  }
}

/**
 * Locate the Claude driver manifest when the caller does not supply one.
 *
 * The plugin passes the path explicitly because it is the package that declares
 * the dependency; this fallback covers direct construction (and the packaged
 * bundle), where the resolution walks from the published package root.
 */
function defaultEngineManifestPath(): string {
  const require = createRequire(import.meta.url)
  try {
    return require.resolve('@deepseek-ai/dsh-freecodego-runtime-claude/package.json')
  } catch {
    return join(process.cwd(), 'packages', 'freecodego', 'runtime-claude', 'package.json')
  }
}

function readMarker(path: string): ClaudeRuntimeMarker | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<ClaudeRuntimeMarker>
    if (
      value.formatVersion !== 1
      || value.engine !== 'claude'
      || typeof value.platform !== 'string'
      || typeof value.protocolAbi !== 'string'
      || typeof value.runtimeVersion !== 'string'
      || typeof value.artifactDigest !== 'string'
      || typeof value.sourceRevision !== 'string'
      || typeof value.executablePath !== 'string'
    ) return undefined
    return value as ClaudeRuntimeMarker
  } catch {
    return undefined
  }
}

function unavailable(reason?: string): Error & { code: string } {
  const error = new Error('Claude Agent SDK runtime is not installed. Install it from the FreeCodeGo engine settings.') as Error & { code: string }
  error.code = reason ?? 'CLAUDE_RUNTIME_NOT_INSTALLED'
  return error
}

function currentClaudePackage() {
  const platform = currentRuntimePlatform()
  const found = claudeRuntimePackages.find(item => item.platform === platform)
  if (found === undefined) throw new Error(`Claude package for ${platform} is unavailable`)
  return found
}
