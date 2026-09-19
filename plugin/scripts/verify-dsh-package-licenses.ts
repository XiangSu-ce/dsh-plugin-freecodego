/**
 * Enforce the license declaration each repository-owned DSH npm package must carry.
 *
 * The rule is a split, not a single value. The FreeCodeGo extension is licensed
 * AGPL-3.0-only, and the root manifest declares the repository that ships it;
 * every other `@deepseek-ai/dsh*` package is Harness core and stays MIT. Naming
 * both sides here is what keeps a relicence from being undone by a manifest
 * edit, and keeps a Harness package from silently inheriting the extension's
 * license.
 * @module scripts/verify-dsh-package-licenses
 */

import { globSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DSH_PACKAGE_NAME = /^@deepseek-ai\/dsh(?:-|$)/
/** The license the FreeCodeGo extension declares, and the one its root manifest declares. */
const EXTENSION_LICENSE = 'AGPL-3.0-only'
/** Harness core keeps the permissive license the upstream project publishes. */
const HARNESS_LICENSE = 'MIT'
/** Repository-relative prefix of the extension's own package tree. */
const EXTENSION_PACKAGE_PREFIX = 'packages/freecodego/'

/** Result of checking every DSH package reachable through the root workspace list. */
export interface DshPackageLicenseReport {
  /** Number of DSH package manifests checked. */
  packageCount: number
  /** Repository-relative diagnostics for declarations that do not match the package's side of the split. */
  failures: string[]
}

function readManifest(root: string, file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(resolve(root, file), 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`verify-dsh-package-licenses: ${file} must contain a JSON object.`)
  }
  return parsed as Record<string, unknown>
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string')
}

function workspaceManifestPaths(root: string): string[] {
  const rootManifest = readManifest(root, 'package.json')
  const workspaces = rootManifest.workspaces
  if (!isStringArray(workspaces)) {
    throw new Error('verify-dsh-package-licenses: package.json workspaces must be a string array.')
  }

  const files = new Set(['package.json'])
  for (const pattern of workspaces) {
    for (const file of globSync(`${pattern}/package.json`, { cwd: root })) {
      files.add(file)
    }
  }
  return [...files].sort()
}

function printable(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value)
}

/**
 * Which license a repository-relative manifest must declare.
 * @param normalizedFile - repository-relative manifest path with forward slashes.
 * @returns the extension license for the root manifest and the extension package tree, otherwise the Harness license.
 */
function requiredLicense(normalizedFile: string): string {
  return normalizedFile === 'package.json' || normalizedFile.startsWith(EXTENSION_PACKAGE_PREFIX)
    ? EXTENSION_LICENSE
    : HARNESS_LICENSE
}

/**
 * Check every DSH npm package declared by the repository workspace.
 * @param root - absolute repository root containing the workspace package.json.
 * @returns the checked package count and every non-conforming declaration.
 */
export function inspectDshPackageLicenses(root: string): DshPackageLicenseReport {
  let packageCount = 0
  const failures: string[] = []

  for (const file of workspaceManifestPaths(root)) {
    const manifest = readManifest(root, file)
    const name = manifest.name
    if (typeof name !== 'string' || !DSH_PACKAGE_NAME.test(name)) continue

    packageCount++
    const normalizedFile = file.split(sep).join('/')
    const expected = requiredLicense(normalizedFile)
    if (manifest.license !== expected) {
      failures.push(
        `${normalizedFile}: ${name} must declare "license": "${expected}"; found ${printable(manifest.license)}.`,
      )
    }
  }

  return { packageCount, failures }
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const report = inspectDshPackageLicenses(ROOT)
  if (report.failures.length > 0) {
    process.stderr.write('verify-dsh-package-licenses: license declarations that do not match the package split found:\n')
    for (const failure of report.failures) process.stderr.write(`  ${failure}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(
      `verify-dsh-package-licenses: ${String(report.packageCount)} DSH package(s) checked; the extension declares ${EXTENSION_LICENSE} and Harness core declares ${HARNESS_LICENSE}.\n`,
    )
  }
}
