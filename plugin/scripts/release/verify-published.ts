/**
 * Verify one packed tarball and the registry carry one version and one set of
 * bytes.
 *
 * A release is published to two places from a single file: the GitHub release
 * asset an update check downloads, and the registry version the Harness CLI
 * resolves a bare package name to. "Published" therefore only means what the
 * two places agree on, and the ways they can disagree are the ones checked here
 * — a version present in one place and absent in the other, a version present
 * as different bytes, a Harness baseline the registry does not carry (so the
 * CLI's own version selection cannot recognise it), or a publish that landed
 * under a channel tag the family does not publish on.
 *
 * The registry is read through `npm view`, as a consumer reads it, rather than
 * trusting what the publish step reported about its own work.
 *
 * The release half is verified by the workflow step that re-reads the release
 * from the API; both halves are checked against the same packed file, which is
 * why this needs no download to compare them.
 */

import { parseArgs } from 'node:util'
import { releaseFamily } from './families.ts'
import { npmInvocation } from '../pnpm-invocation.ts'
import { attempt, isEntry } from './process.ts'
import { awaitRegistryState, SETTLE_TIMEOUT_MS } from './registry.ts'
import { integrityOf, packedIdentity, packedManifest } from './tarball.ts'

/** npm's own channel name for a version a family publishes without a tag. */
const DEFAULT_CHANNEL = 'latest'

/**
 * Read one field of one version from the registry.
 * @param spec - a registry spec: `name@version` or `name@tag`.
 * @param field - the manifest field to read, dotted as npm addresses it.
 * @returns The field as JSON.
 */
function registryField(spec: string, field: string): unknown {
  const view = npmInvocation(['view', spec, field, '--json'])
  const result = attempt(view.command, view.args)
  if (result.status !== 0) {
    throw new Error(`npm view ${spec} ${field} failed:\n${result.stdout}${result.stderr}`)
  }
  return JSON.parse(result.stdout) as unknown
}

/**
 * Read one field the registry must answer as a string.
 * @param spec - a registry spec: `name@version` or `name@tag`.
 * @param field - the manifest field to read, dotted as npm addresses it.
 * @returns The string the registry reported.
 */
function registryString(spec: string, field: string): string {
  const value = registryField(spec, field)
  if (typeof value !== 'string' || value === '') {
    throw new Error(`the registry reports no ${field} for ${spec}`)
  }
  return value
}

/** Verify the tarball named by `--tarball` against the family named by `--family`. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { family: { type: 'string' }, tarball: { type: 'string' } },
    allowPositionals: false,
  })
  if (values.family === undefined || values.tarball === undefined) {
    throw new Error('usage: verify-published.ts --family <dsh|freecodego|vendor> --tarball <packed tarball>')
  }

  const family = releaseFamily(values.family)
  const tarball = values.tarball
  const { name, version } = packedIdentity(tarball)
  const spec = `${name}@${version}`

  // The bytes, not the claim: the registry's integrity for this version has to
  // be the hash of the file this release uploaded and published. The registry is
  // given time to settle first, because it acknowledges an upload before the
  // version it carries can be read — a single read after the publish step says
  // nothing about a version that is still arriving, and would fail a release
  // whose two halves do agree.
  const packed = integrityOf(tarball)
  const state = await awaitRegistryState(name, version)
  if (state.kind === 'absent') {
    throw new Error(
      `${spec} is not on the registry, ${String(SETTLE_TIMEOUT_MS / 1000)}s after the publish step ran`
      + '\nThe registry acknowledged the upload without publishing it (npm prints'
      + '\n  "Your package is being processed and may take a few minutes to become available."'
      + '\nand exits 0). Re-run the publish job: the registry skips a version it already'
      + '\n  carries, so re-running is safe.',
    )
  }
  if (state.integrity !== packed) {
    throw new Error(
      `${spec} is published with different content than the release packed`
      + `\n  registry: ${state.integrity}\n  packed:   ${packed}`,
    )
  }

  // Only a bundle that declares a Harness baseline makes a claim about which
  // Host can mount it; when it does, the registry has to carry the same one,
  // because that field is what the CLI selects a version by.
  const manifest = packedManifest(tarball)
  const freecodego = manifest.freecodego
  const declared = freecodego !== null && typeof freecodego === 'object' && !Array.isArray(freecodego)
    ? (freecodego as Record<string, unknown>).harnessBaseline
    : undefined
  if (typeof declared === 'string') {
    const carried = registryString(spec, 'freecodego.harnessBaseline')
    if (carried !== declared) {
      throw new Error(
        `${spec} declares Harness baseline ${carried} on the registry, but the release packed ${declared}`
        + '; the CLI would not offer this version to the Harness it was built for',
      )
    }
  }

  // The family publishes a prerelease under its channel and a stable version
  // under npm's default, so the tag that answers is part of the contract: a
  // version published under another tag is a version its users cannot resolve.
  const channel = family.distTagForVersion(version) ?? DEFAULT_CHANNEL
  const tagged = registryString(`${name}@${channel}`, 'version')
  if (tagged !== version) {
    throw new Error(
      `${name}@${channel} names ${tagged}, but this release published ${version}`
      + `; the family publishes ${version} under ${channel}`,
    )
  }

  console.log(
    `release verify-published: family ${family.id}, ${spec} agreed by the registry`
    + ` — integrity,${typeof declared === 'string' ? ` Harness baseline ${declared},` : ''} channel ${channel}`,
  )
}

if (isEntry(import.meta.url)) await main()
