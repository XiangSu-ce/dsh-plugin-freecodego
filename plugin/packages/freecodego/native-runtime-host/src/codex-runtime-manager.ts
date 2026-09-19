import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { currentRuntimePlatform, resolveContained, validateRuntimeManifest, verifyRuntimeArtifact, type NativeRuntimeManifest } from './manifest.ts'
import { downloadRuntimeArchive, extractRuntimeArchive, preserveRuntimeArchive } from './runtime-download.ts'
import { codexRuntimePackages } from './runtime-packages.ts'

export interface CodexRuntimeStatus {
  readonly installed: boolean
  readonly platform: string
  readonly runtimeVersion?: string
  readonly artifactDigest?: string
  readonly sourceRevision?: string
  readonly path?: string
  readonly reason?: string
}

export interface CodexRuntimeConfig {
  readonly rootDirectory?: string
  /** Retained for profile compatibility. Official runtime packages now download on demand. */
  readonly sourceDirectory?: string
  readonly maxArtifactBytes?: number
}

export interface CodexRuntimePackage {
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

/**
 * Owns the optional Codex runtime. Installation is explicit and atomic; a
 * partially downloaded/copied runtime is never exposed to the router.
 * The manager deliberately keeps the runtime below DSH_HOME and never uses
 * the user's global CODEX_HOME.
 */
export class CodexRuntimeManager {
  readonly rootDirectory: string
  private readonly maxArtifactBytes: number
  private operation: Promise<unknown> | undefined

  constructor(config: CodexRuntimeConfig = {}) {
    const home = process.env.DSH_HOME?.trim() || join(process.env.USERPROFILE || process.env.HOME || process.cwd(), '.dsh')
    this.rootDirectory = resolve(config.rootDirectory || join(home, 'runtimes', 'codex'))
    this.maxArtifactBytes = config.maxArtifactBytes ?? 1024 * 1024 * 1024
    if (!Number.isSafeInteger(this.maxArtifactBytes) || this.maxArtifactBytes <= 0) throw new Error('Codex runtime maxArtifactBytes is invalid')
  }

  status(): CodexRuntimeStatus {
    const platformId = currentRuntimePlatform()
    const manifestPath = join(this.rootDirectory, 'artifacts', artifactDirectory(platformId), 'manifest.json')
    if (!existsSync(manifestPath)) return { installed: false, platform: platformId, reason: 'CODEX_RUNTIME_NOT_INSTALLED' }
    try {
      const manifest = validateRuntimeManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
      if (!existsSync(join(this.rootDirectory, '.complete'))) return { installed: false, platform: platformId, reason: 'CODEX_RUNTIME_INCOMPLETE' }
      return { installed: true, platform: platformId, runtimeVersion: manifest.runtimeAbi, artifactDigest: manifest.artifactDigest, sourceRevision: manifest.sourceRevision, path: this.rootDirectory }
    } catch (error) {
      return { installed: false, platform: platformId, reason: error instanceof Error ? `CODEX_RUNTIME_INVALID:${error.message}` : 'CODEX_RUNTIME_INVALID' }
    }
  }

  async runtime(): Promise<{ readonly manifest: NativeRuntimeManifest; readonly executable: string; readonly args?: readonly string[]; readonly rootDirectory: string }> {
    const platformId = currentRuntimePlatform()
    const manifestPath = join(this.rootDirectory, 'artifacts', artifactDirectory(platformId), 'manifest.json')
    let manifest: NativeRuntimeManifest
    try { manifest = validateRuntimeManifest(JSON.parse(await readFile(manifestPath, 'utf8'))) } catch { throw unavailable() }
    // The same containment check `verifyRuntimeArtifact` applies to the digest
    // below, so the file that is stat'd is the file whose bytes are hashed.
    const executable = resolveContained(this.rootDirectory, manifest.artifactPath)
    const info = await stat(executable)
    if (!info.isFile() || info.size > this.maxArtifactBytes) throw new Error('Codex runtime artifact is invalid')
    await verifyRuntimeArtifact(manifest, this.rootDirectory)
    return { manifest, executable, ...(manifest.args === undefined ? {} : { args: manifest.args }), rootDirectory: this.rootDirectory }
  }

  async packages(): Promise<readonly CodexRuntimePackage[]> {
    const currentPlatform = currentRuntimePlatform()
    return codexRuntimePackages.map(spec => ({
      id: spec.id,
      platform: spec.platform,
      label: spec.label,
      runtimeVersion: spec.runtimeVersion,
      sourceRevision: spec.sourceRevision,
      installDirectory: join(this.rootDirectory, 'artifacts', artifactDirectory(spec.platform)),
      compatible: spec.platform === currentPlatform,
      source: 'official',
      downloadURL: spec.downloadURL,
    }))
  }

  async install(packageID = currentCodexPackage().id): Promise<CodexRuntimeStatus> {
    return this.serialize(async () => {
      const platformId = currentRuntimePlatform()
      const spec = codexRuntimePackages.find(item => item.id === packageID)
      if (spec === undefined || spec.platform !== platformId) throw new Error(`Codex package ${packageID} is not compatible with ${platformId}`)
      const archive = await downloadRuntimeArchive(spec, join(this.rootDirectory, '.downloads'))
      const staging = `${this.rootDirectory}.extract-${process.pid}-${Date.now()}`
      const extractedPackage = await extractRuntimeArchive(archive, staging)
      const temporary = `${this.rootDirectory}.partial-${process.pid}-${Date.now()}`
      const backup = `${this.rootDirectory}.old-${process.pid}-${Date.now()}`
      try {
        const artifactRoot = join(temporary, 'artifacts', artifactDirectory(platformId), 'package')
        await rm(temporary, { recursive: true, force: true })
        await copyTree(extractedPackage, artifactRoot)
        const executable = await findCodexExecutable(artifactRoot, platformId)
        if (executable === '') throw new Error(`Codex package ${packageID} does not contain a ${platformId} executable`)
        const manifest: NativeRuntimeManifest = {
          manifestVersion: 1,
          engine: 'codex',
          platform: platformId,
          protocolAbi: 'freecodego-agent/1',
          runtimeAbi: spec.runtimeVersion,
          artifactPath: relative(temporary, executable).replaceAll('\\', '/'),
          args: ['app-server'],
          artifactDigest: `sha256:${await sha256(executable)}`,
          sourceRevision: spec.sourceRevision,
          licenseNotice: relative(temporary, join(artifactRoot, 'README.md')).replaceAll('\\', '/'),
          minimumPluginVersion: '0.1.3-alpha.1',
        }
        await writeFile(join(temporary, 'artifacts', artifactDirectory(platformId), 'manifest.json'), `${JSON.stringify(manifest)}\n`, 'utf8')
        await preserveRuntimeArchive(archive, temporary)
        await verifyRuntimeArtifact(manifest, temporary)
        try { await rename(this.rootDirectory, backup) } catch (error) {
          if ((error as { code?: unknown }).code !== 'ENOENT') throw error
        }
        try {
          await mkdir(dirname(this.rootDirectory), { recursive: true })
          await writeFile(join(temporary, '.complete'), `${manifest.sourceRevision}\n`, 'utf8')
          await rename(temporary, this.rootDirectory)
        } catch (error) {
          // Surface double failure: a swallowed restore error would leave no
          // runtime at all while the caller assumes the old one survived.
          await rename(backup, this.rootDirectory).catch((restoreError: unknown) => {
            throw new Error(`Codex runtime install failed (${error instanceof Error ? error.message : String(error)}), and restoring the previous runtime also failed (${restoreError instanceof Error ? restoreError.message : String(restoreError)}); the backup remains at ${backup}`)
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

  async remove(): Promise<CodexRuntimeStatus> {
    return this.serialize(async () => {
      await rm(this.rootDirectory, { recursive: true, force: true })
      if (existsSync(this.rootDirectory)) throw new Error(`Codex runtime directory still exists after removal: ${this.rootDirectory}`)
      return this.status()
    })
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operation ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(operation)
    this.operation = run
    try { return await run } finally { if (this.operation === run) this.operation = undefined }
  }
}

function unavailable(): Error & { code: string } {
  const error = new Error('Codex runtime is not installed. Install it from the FreeCodeGo engine settings.') as Error & { code: string }
  error.code = 'CODEX_RUNTIME_NOT_INSTALLED'
  return error
}

async function copyTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) await copyTree(from, to)
    else if (entry.isFile()) await copyFile(from, to)
  }
}

function artifactDirectory(platformId: string): string {
  return platformId.startsWith('win32-') ? platformId.replace(/^win32-/, 'windows-') : platformId
}

function currentCodexPackage() {
  const platform = currentRuntimePlatform()
  const found = codexRuntimePackages.find(item => item.platform === platform)
  if (found === undefined) throw new Error(`Codex package for ${platform} is unavailable`)
  return found
}

async function findCodexExecutable(root: string, platform: string): Promise<string> {
  const expected = platform.startsWith('win32-') ? 'codex.exe' : 'codex'
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isFile() && entry.name === expected) return path
    if (entry.isDirectory()) {
      const found = await findCodexExecutable(path, platform)
      if (found !== '') return found
    }
  }
  return ''
}

async function sha256(path: string): Promise<string> {
  const digest = await readFile(path)
  return createHash('sha256').update(digest).digest('hex')
}
