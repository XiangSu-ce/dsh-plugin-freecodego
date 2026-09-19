import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, normalize, relative } from 'node:path'
import { arch, platform } from 'node:process'

export type NativeRuntimeEngine = 'codex' | 'claude'
export type NativeRuntimePlatform = 'win32-x64' | 'win32-arm64' | 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64'

export interface NativeRuntimeManifest {
  readonly manifestVersion: 1
  readonly engine: NativeRuntimeEngine
  readonly platform: NativeRuntimePlatform
  readonly protocolAbi: string
  readonly runtimeAbi: string
  readonly artifactPath: string
  readonly args?: readonly string[]
  readonly artifactDigest: string
  readonly sourceRevision: string
  readonly licenseNotice: string
  readonly minimumPluginVersion: string
}

/**
 * The runtime platform id for one OS/architecture pair.
 *
 * Only the two architectures a published artifact exists for are mapped. Every
 * other `process.arch` (`ia32`, `ppc64`, `s390x`, `riscv64`, …) is refused rather
 * than folded into `x64`: an x64 artifact selected for an incompatible machine
 * installs cleanly, verifies its digest, and only fails much later inside the
 * worker, which reads as a broken runtime instead of an unsupported host.
 * @param platformName - a `process.platform` value.
 * @param architecture - a `process.arch` value.
 * @returns the platform id shared with the runtime manifests.
 */
export function runtimePlatformFor(platformName: string, architecture: string): NativeRuntimePlatform {
  const cpu = architecture === 'arm64' ? 'arm64' : architecture === 'x64' ? 'x64' : undefined
  if (cpu === undefined) throw new Error(`unsupported native runtime architecture ${architecture}`)
  if (platformName === 'win32' || platformName === 'linux' || platformName === 'darwin') return `${platformName}-${cpu}` as NativeRuntimePlatform
  throw new Error(`unsupported native runtime platform ${platformName}-${architecture}`)
}

/** The runtime platform of the running process. */
export function currentRuntimePlatform(): NativeRuntimePlatform {
  return runtimePlatformFor(platform, arch)
}

export function validateRuntimeManifest(value: unknown): NativeRuntimeManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('runtime manifest must be an object')
  const item = value as Record<string, unknown>
  const engine = item.engine === 'codex' || item.engine === 'claude' ? item.engine : undefined
  if (engine === undefined) throw new Error('runtime manifest engine is invalid')
  const platforms: NativeRuntimePlatform[] = ['win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']
  if (!platforms.includes(item.platform as NativeRuntimePlatform)) throw new Error('runtime manifest platform is invalid')
  const required = ['protocolAbi', 'runtimeAbi', 'artifactPath', 'artifactDigest', 'sourceRevision', 'licenseNotice', 'minimumPluginVersion']
  for (const key of required) if (typeof item[key] !== 'string' || (item[key]).trim() === '') throw new Error(`runtime manifest ${key} is required`)
  if (item.args !== undefined && (!Array.isArray(item.args) || item.args.some(argument => typeof argument !== 'string' || argument.length > 256))) throw new Error('runtime manifest args are invalid')
  if (item.manifestVersion !== 1) throw new Error('runtime manifest version is unsupported')
  if (!/^(sha256:)?[a-f0-9]{64}$/i.test(item.artifactDigest as string)) throw new Error('runtime manifest artifactDigest must be SHA-256')
  for (const key of ['artifactPath', 'licenseNotice']) {
    const path = item[key] as string
    const cleaned = normalize(path)
    if (isAbsolute(path) || cleaned === '..' || cleaned.startsWith(`..${requireSeparator()}`)) {
      throw new Error(`runtime manifest ${key} must stay inside the artifact root`)
    }
  }
  return item as unknown as NativeRuntimeManifest
}

export async function verifyRuntimeArtifact(manifest: NativeRuntimeManifest, rootDirectory: string): Promise<void> {
  if (manifest.platform !== currentRuntimePlatform()) throw new Error(`runtime manifest platform ${manifest.platform} is not supported on ${currentRuntimePlatform()}`)
  const artifact = resolveContained(rootDirectory, manifest.artifactPath)
  const notice = resolveContained(rootDirectory, manifest.licenseNotice)
  await readFile(notice)
  const digest = createHash('sha256').update(await readFile(artifact)).digest('hex')
  const expected = manifest.artifactDigest.replace(/^sha256:/i, '').toLowerCase()
  if (digest !== expected) throw new Error(`runtime artifact digest mismatch for ${manifest.engine}`)
}

function requireSeparator(): string {
  return process.platform === 'win32' ? '\\' : '/'
}

/**
 * Resolve a manifest- or marker-relative path, refusing anything that leaves
 * the runtime root.
 *
 * Exported because every reader of one of those files has to resolve it the same
 * way: a manager that stat'd an executable through a bare `resolve` while the
 * digest was checked through this one would be checking two different files the
 * day the two ever disagreed.
 * @param rootDirectory - the runtime root the path must stay inside.
 * @param child - the relative path a manifest or marker declared.
 * @returns the resolved absolute path.
 */
export function resolveContained(rootDirectory: string, child: string): string {
  const root = normalize(rootDirectory)
  const resolved = normalize(`${rootDirectory}/${child}`)
  const rel = relative(root, resolved)
  if (rel === '..' || rel.startsWith(`..${requireSeparator()}`) || isAbsolute(rel)) {
    throw new Error('runtime manifest path escapes the artifact root')
  }
  return resolved
}
