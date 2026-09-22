/**
 * Plugin-owned private runtime directory primitives.
 *
 * Both engine managers (Graphify and CodeGraph) publish a runtime the same way:
 * stage it, verify it, atomically swap it into place, and record a small
 * manifest naming the pinned version and digest that directory holds. Those
 * rules live here exactly once, so a hardening fix — a symlink refusal, a
 * restore-on-failed-swap — can never land in one engine and miss the other.
 *
 * It also owns the build lifecycle both engines share (one build per workspace,
 * and the abort handle a cancel aborts), so the two engines cannot drift on
 * what "already building" or "cancelled" means.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/engineering-runtime-store
 */

import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, lstatSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Name of the manifest every plugin-owned runtime directory carries. */
export const RUNTIME_MANIFEST_FILE = 'runtime-state.json'

/**
 * Longest accepted transfer for one pinned artifact. The official engine
 * bundles are 48-62 MB, which no short request timeout can cover on a modest
 * link, so this bounds a stall rather than a slow-but-progressing download.
 */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000

/** One digest-pinned artifact to fetch into `destination`. */
export interface VerifiedDownload {
  readonly url: string
  readonly digest: string
  readonly maxBytes: number
  readonly label: string
  readonly destination: string
}

/** The bytes themselves are wrong (size or digest). Retrying cannot fix that. */
class ContentIntegrityError extends Error {}

/**
 * Download one pinned artifact, streaming it straight to disk while hashing so
 * a 60 MB bundle never has to sit in the Host's heap, and verify it against the
 * digest published with its release.
 *
 * A transient transfer failure is retried once (a CDN hiccup, a dropped
 * connection); an integrity failure is NOT — that content is simply wrong. The
 * partial file is removed on every failure path, so a caller never picks up a
 * half-written artifact.
 * @param input - the asset to fetch, its destination, and the digest to verify against.
 * @param fetchImpl - the fetch implementation to download through.
 */
export async function downloadVerifiedAsset(input: VerifiedDownload, fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    await downloadVerifiedOnce(input, fetchImpl)
  } catch (error) {
    if (error instanceof ContentIntegrityError) throw error
    await downloadVerifiedOnce(input, fetchImpl)
  }
}

async function downloadVerifiedOnce(input: VerifiedDownload, fetchImpl: typeof fetch): Promise<void> {
  const response = await fetchImpl(input.url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { accept: 'application/octet-stream', 'user-agent': 'FreeCodeGo-Harness' },
  })
  if (!response.ok || response.body === null) throw new Error(`${input.label} 下载失败（HTTP ${response.status}）。`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > input.maxBytes) throw new ContentIntegrityError(`${input.label} 超过允许大小。`)
  const digest = createHash('sha256')
  let received = 0
  // A metering transform hashes and bounds the body while `pipeline` streams it
  // straight to disk: a 60 MB bundle never has to sit in the Host's heap, and
  // pipeline owns backpressure and error teardown rather than hand-rolled
  // writes (where one missed 'error' listener would crash the process).
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength
      if (received > input.maxBytes) { callback(new ContentIntegrityError(`${input.label} 超过允许大小。`)); return }
      digest.update(chunk)
      callback(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(input.destination, { mode: 0o600 }))
  } catch (error) {
    await rm(input.destination, { force: true })
    throw error
  }
  if (received === 0) {
    await rm(input.destination, { force: true })
    throw new ContentIntegrityError(`${input.label} 大小无效。`)
  }
  if (digest.digest('hex') !== input.digest) {
    await rm(input.destination, { force: true })
    throw new ContentIntegrityError(`${input.label} SHA-256 校验失败。`)
  }
}

/**
 * Create a private directory (mode 0700) and refuse to operate through a
 * symlinked leaf or parent: everything under it is code the plugin later
 * executes, so a link planted in DSH_HOME must never be followed or written to.
 * @param directory - directory the operation runs against.
 * @param label - the label to record with the entry.
 */
export async function ensurePrivateDirectory(directory: string, label: string): Promise<void> {
  const parent = dirname(directory)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new Error(`${label} 私有目录不能是符号链接。`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (lstatSync(directory).isSymbolicLink()) throw new Error(`${label} 私有目录不能是符号链接。`)
}

/**
 * Publish a fully prepared staging directory at `target`. The previous runtime
 * is renamed aside rather than deleted, and only removed once the swap has
 * succeeded — so a failure anywhere in the swap restores it instead of leaving
 * the plugin without a working runtime.
 *
 * That promise covers the swap. A caller with more to check *after* it — both
 * engines verify the runtime at its final path, because a staged check cannot
 * prove a moved environment still runs — asks for `keepPrevious` and gets back
 * the directory the old runtime was parked at, so it can put it back instead of
 * deleting the only working copy (see {@link replaceVerifiedRuntimeDirectory}).
 * @param staging - the fully prepared directory to publish.
 * @param target - where it must end up.
 * @param options.keepPrevious - keep the previous runtime instead of removing it,
 *   and return its path so the caller owns what happens to it next.
 * @returns the parked previous runtime's path, or undefined when there was none
 *   (or when it has already been removed).
 */
export async function replaceRuntimeDirectory(
  staging: string,
  target: string,
  options: { readonly keepPrevious?: boolean } = {},
): Promise<string | undefined> {
  const backup = `${target}.previous`
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  await rm(backup, { recursive: true, force: true })
  const hadPrevious = existsSync(target)
  if (hadPrevious) await rename(target, backup)
  try {
    await rename(staging, target)
    if (options.keepPrevious !== true) await rm(backup, { recursive: true, force: true })
  } catch (error) {
    if (!existsSync(target) && existsSync(backup)) await rename(backup, target)
    throw error
  }
  return hadPrevious && options.keepPrevious === true ? backup : undefined
}

/**
 * Publish a verified staging directory and confirm it still works where it landed.
 *
 * The step after {@link replaceRuntimeDirectory}, which both engine installers
 * perform and neither can get right alone: their staged runtime is verified at
 * its staging path, so the only check that proves the *published* one works is one
 * that runs after the move — and answering a failure there by deleting the
 * published directory leaves a plugin that had a working runtime with none, since
 * the previous one is gone by then. Here the previous directory is kept until
 * `verify` passes and put back when it does not.
 *
 * `verify` receives the published path and reports failure by throwing: the
 * engines' checks are subprocess runs whose verdict is an exit code and a version
 * string, and turning that into a throw is the caller's business.
 * @param input.staging - the fully prepared directory to publish.
 * @param input.target - where it must end up.
 * @param input.verify - run against the published path; throws when it is unusable.
 */
export async function replaceVerifiedRuntimeDirectory(input: {
  readonly staging: string
  readonly target: string
  readonly verify: (published: string) => Promise<void>
}): Promise<void> {
  const { staging, target, verify } = input
  const previous = await replaceRuntimeDirectory(staging, target, { keepPrevious: true })
  try {
    await verify(target)
  } catch (error) {
    // The published copy failed its own check, so it is not the runtime anyone
    // should be left with. What was there before it may still be, and is the only
    // fallback left — deleting instead is how a repair becomes a removal.
    await rm(target, { recursive: true, force: true })
    if (previous !== undefined) await rename(previous, target)
    throw error
  }
  if (previous !== undefined) await rm(previous, { recursive: true, force: true })
}

/** Write the manifest that makes an installed runtime self-describing.
 * @param directory - directory the operation runs against.
 * @param manifest - the manifest object to serialize.
 */
export async function writeRuntimeManifest(directory: string, manifest: unknown): Promise<void> {
  await writeFile(join(directory, RUNTIME_MANIFEST_FILE), JSON.stringify(manifest), { encoding: 'utf8', mode: 0o600 })
}

/**
 * Read a runtime manifest. A missing, unreadable, or malformed file reports as
 * "not installed" (undefined) instead of throwing: every caller renders that as
 * `state: 'unavailable'`, and a corrupted manifest must never break startup.
 * @param directory - directory the operation runs against.
 * @param validate - narrows the parsed record, returning `undefined` when it is unusable.
 * @returns the validated manifest, or `undefined` when none is installed.
 */
export async function readRuntimeManifest<T>(directory: string, validate: (value: Record<string, unknown>) => T | undefined): Promise<T | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(directory, RUNTIME_MANIFEST_FILE), 'utf8'))
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    return validate(raw as Record<string, unknown>)
  } catch { return undefined }
}

/**
 * One plugin-owned build per workspace, plus the abort handle that cancels it.
 *
 * Both engines publish a build the same way: claim the workspace **before the
 * first `await`** so two builds cannot race on one output directory, hand the
 * runner a controller `cancel` can abort, and release the claim in a `finally`.
 * Those rules live here once so the two engines cannot disagree about what
 * "already building" or "cancelled" means.
 *
 * The release must happen BEFORE a caller derives its final project status:
 * `projectStatus` answers `building` from this same claim, synchronously, so
 * computing the status inside the `finally` that still holds the claim reports
 * a finished build as still running.
 */
export class BuildTracker {
  private readonly building = new Set<string>()
  private readonly controllers = new Map<string, AbortController>()

  /** True while a build holds this workspace: the concurrency guard and the `building` status.
   * @param projectId - project this operation is scoped to.
   * @returns true while a build holds the workspace.
   */
  isBuilding(projectId: string): boolean { return this.building.has(projectId) }

  /** Take the workspace for one build, or refuse when another already holds it.
   * @param projectId - project this operation is scoped to.
   * @param message - the error message thrown when the workspace is already claimed.
   */
  claim(projectId: string, message: string): void {
    if (this.building.has(projectId)) throw new Error(message)
    this.building.add(projectId)
  }

  /** Publish the abort handle of a claimed workspace once its runner exists.
   * @param projectId - project this operation is scoped to.
   * @param controller - the controller whose abort cancels the build.
   */
  attach(projectId: string, controller: AbortController): void {
    this.controllers.set(projectId, controller)
  }

  /** Release the workspace whether the build succeeded, failed, or was aborted. 
   * @param projectId - project this operation is scoped to.
   */
  release(projectId: string): void {
    this.building.delete(projectId)
    this.controllers.delete(projectId)
  }

  /** Abort the plugin-owned build for one workspace; false when none is running.
   * @param projectId - project this operation is scoped to.
   * @returns whether a running build was cancelled.
   */
  cancel(projectId: string): { readonly cancelled: boolean } {
    const controller = this.controllers.get(projectId)
    if (controller === undefined) return { cancelled: false }
    controller.abort('cancelled by user')
    return { cancelled: true }
  }
}
