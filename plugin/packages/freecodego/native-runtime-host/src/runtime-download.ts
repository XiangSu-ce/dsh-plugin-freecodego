import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { extract } from 'tar'
import type { NativeRuntimePlatform } from './manifest.ts'

export interface RuntimeDownloadSpec {
  readonly id: string
  readonly engine: 'codex' | 'claude'
  readonly platform: NativeRuntimePlatform
  readonly label: string
  readonly version: string
  readonly runtimeVersion: string
  readonly sourceRevision: string
  readonly downloadURL: string
  readonly integrity: string
  readonly maxArchiveBytes: number
}

export interface RuntimePackageOption {
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

/** Download and verify one immutable official npm tarball into the runtime cache. */
export async function downloadRuntimeArchive(spec: RuntimeDownloadSpec, downloadDirectory: string): Promise<string> {
  await mkdir(downloadDirectory, { recursive: true })
  const archive = join(downloadDirectory, `${safePackageName(spec.id)}.tgz`)
  if (await fileMatchesIntegrity(archive, spec.integrity)) return archive

  const partial = `${archive}.partial-${process.pid}-${Date.now()}`
  await rm(partial, { force: true })
  let lastError: unknown
  for (const url of downloadCandidates(spec.downloadURL)) {
    try {
      await downloadToFile(url, partial, spec.maxArchiveBytes)
      if (!await fileMatchesIntegrity(partial, spec.integrity)) throw new Error(`Downloaded ${spec.label} package failed integrity verification`)
      await rm(archive, { force: true })
      await rename(partial, archive)
      return archive
    } catch (error) {
      lastError = error
      await rm(partial, { force: true })
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Failed to download ${spec.label}`)
}

/** Extract a verified tarball into a new private staging directory. */
export async function extractRuntimeArchive(archive: string, stagingDirectory: string): Promise<string> {
  await rm(stagingDirectory, { recursive: true, force: true })
  await mkdir(stagingDirectory, { recursive: true })
  await extract({ file: archive, cwd: stagingDirectory, strict: true, preservePaths: false })
  return join(stagingDirectory, 'package')
}

/** Preserve a verified archive across the atomic runtime-directory swap. */
export async function preserveRuntimeArchive(archive: string, temporaryRuntimeRoot: string): Promise<void> {
  const destination = join(temporaryRuntimeRoot, '.downloads', basename(archive))
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(archive, destination)
}

function downloadCandidates(url: string): readonly string[] {
  const mirror = url.replace('https://registry.npmjs.org/', 'https://registry.npmmirror.com/')
  return mirror === url ? [url] : [mirror, url]
}

async function downloadToFile(url: string, destination: string, maxBytes: number): Promise<void> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) })
  if (!response.ok || response.body === null) throw new Error(`Runtime package download failed with HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Runtime package exceeds the configured archive size limit')

  const file = await open(destination, 'w', 0o600)
  const reader = response.body.getReader()
  let written = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      written += next.value.byteLength
      if (written > maxBytes) throw new Error('Runtime package exceeds the configured archive size limit')
      await file.write(next.value)
    }
  } finally {
    // Cancel rather than only releasing the lock: every exit from the loop above
    // is either completion or a thrown limit/integrity failure, and on the
    // failure path an unlocked-but-unread body leaves the response streaming
    // into a socket nobody will consume. Cancelling is what stops the transfer.
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
    await file.close()
  }
}

async function fileMatchesIntegrity(file: string, integrity: string): Promise<boolean> {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(file)
  } catch (error) {
    // Only "there is no cached archive here" is absorbed; anything else is a
    // real failure the caller has to see.
    if (error !== null && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') return false
    throw error
  }
  if (!info.isFile() || info.size === 0) return false
  const [algorithm, expected] = integrity.split('-', 2)
  if (algorithm !== 'sha512' || expected === undefined || expected === '') throw new Error('Runtime package integrity must use SHA-512')
  // Streamed rather than `readFile`: the archive is a whole runtime package and
  // this runs on every cached check as well as every install, so buffering it
  // duplicated the download's peak memory for a hash that only needs one chunk
  // at a time.
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('base64') === expected
}

function safePackageName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '-')
}
