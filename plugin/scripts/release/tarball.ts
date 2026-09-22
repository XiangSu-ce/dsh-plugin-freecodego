/**
 * Reading packed npm tarballs and the order file that accompanies them.
 *
 * The release steps after pack treat a directory of tarballs as the unit of
 * work, so they read what a tarball declares rather than what the checkout
 * currently says.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { capture } from './process.ts'

/** Name of the file recording the order in which a packed family uploads. */
export const PUBLISH_ORDER_FILE = 'publish-order.txt'

/**
 * tar arguments that keep an archive path local on every platform.
 *
 * GNU tar reads `E:\path` as `host:path` and tries to reach a remote host, so
 * an absolute Windows path fails with `Cannot connect to E: resolve failed`.
 * `--force-local` is the documented way to say the colon is part of a filename,
 * and it is passed only where the ambiguity exists, so a CI run's tar command
 * is the one this repository has always used.
 * @returns Extra leading tar arguments.
 */
function tarPlatformArgs(): string[] {
  return process.platform === 'win32' ? ['--force-local'] : []
}

/** What a packed tarball calls itself. */
export interface PackedIdentity {
  /** Package name from the packed manifest. */
  readonly name: string
  /** Package version from the packed manifest. */
  readonly version: string
}

/**
 * List a tarball's members.
 * @param tarball - absolute tarball path.
 * @returns Every path inside the archive.
 */
export function tarballFiles(tarball: string): string[] {
  return capture('tar', [...tarPlatformArgs(), '-tzf', tarball]).split(/\r?\n/u).filter(line => line !== '')
}

/**
 * Read a packed tarball's own manifest.
 * @param tarball - absolute tarball path.
 * @returns The manifest inside the archive.
 */
export function packedManifest(tarball: string): Record<string, unknown> {
  const manifest: unknown = JSON.parse(capture('tar', [...tarPlatformArgs(), '-xOzf', tarball, 'package/package.json']))
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${tarball} has no manifest`)
  }
  return manifest as Record<string, unknown>
}

/**
 * Read a packed tarball's own manifest.
 * @param tarball - absolute tarball path.
 * @returns The name and version the tarball declares.
 */
export function packedIdentity(tarball: string): PackedIdentity {
  const { name, version } = packedManifest(tarball)
  if (typeof name !== 'string' || typeof version !== 'string') throw new Error(`${tarball} manifest lacks name/version`)
  return { name, version }
}

/**
 * The subresource integrity string npm records for a tarball.
 *
 * Shared by the step that publishes and the step that verifies what was
 * published: a comparison of two hashes is only a comparison of the same bytes
 * if both sides compute it the same way.
 * @param tarball - absolute tarball path.
 * @returns A `sha512-<base64>` string.
 */
export function integrityOf(tarball: string): string {
  return `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`
}

/**
 * Read a packed directory's upload order.
 * @param directory - absolute path of a pack output directory.
 * @returns Tarball filenames in upload order.
 */
export function readPublishOrder(directory: string): string[] {
  return readFileSync(join(directory, PUBLISH_ORDER_FILE), 'utf8').split('\n').filter(line => line !== '')
}
