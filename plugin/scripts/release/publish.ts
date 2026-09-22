/**
 * Publish one packed release family from the tarballs the pack step produced.
 *
 * Publication is decided per package against the registry, never from a list of
 * "what this release includes": a version the registry lacks is published, a
 * version whose published tarball has the same integrity is skipped, and a
 * version whose published tarball differs fails the run — that last case means
 * the content changed without a version bump
 * ([rationale](../../.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md)).
 *
 * Skipping on identical integrity is what makes re-running the publish step over
 * the same artifact safe.
 */

import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { releaseFamily } from './families.ts'
import { npmInvocation } from '../pnpm-invocation.ts'
import { registryAuthHint } from './auth-diagnosis.ts'
import { attemptEchoed, isEntry } from './process.ts'
import {
  awaitRegistryState,
  FAILED_UPLOAD_PROBE_MS,
  registryState,
  SETTLE_TIMEOUT_MS,
} from './registry.ts'
import { integrityOf, packedIdentity, packedManifest, readPublishOrder } from './tarball.ts'

/**
 * Registry codes that answer a write which did not settle, rather than a
 * rejection of what was sent. `E409 Failed to save packument` is the one this
 * sequence actually hits: publishing several packages in a row can outrun the
 * registry's own processing. A rejected payload (`E403` over an existing
 * version, a malformed manifest) never clears on a retry and must surface.
 */
const TRANSIENT_PUBLISH_CODES = ['E409', 'E429', 'E500', 'E502', 'E503', 'E504', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'] as const

/** How many times one tarball's publish is attempted before the run fails. */
const PUBLISH_ATTEMPTS = 4

/**
 * Shortest gap between two publishes, and the first retry backoff.
 *
 * The registry needs a moment to commit a packument before the next write; back
 * to back publishes are what produce `E409`.
 */
const PUBLISH_SPACING_MS = 2_000

/**
 * Whether a failed publish is worth another attempt.
 * @param output - combined npm output.
 * @returns True when the registry reported a write it did not commit.
 */
function isTransientFailure(output: string): boolean {
  return TRANSIENT_PUBLISH_CODES.some(code => output.includes(`code ${code}`))
}

/**
 * Publish one tarball, retrying a registry write that did not settle.
 *
 * Every retry re-reads the registry first, because `E409` can answer a write
 * that landed anyway: republishing a version that now exists fails permanently,
 * so the same integrity appearing under the failed attempt counts as success.
 * @param tarball - absolute tarball path.
 * @param name - package name the tarball declares.
 * @param version - package version the tarball declares.
 * @param distTag - explicit npm dist-tag, or undefined for npm's `latest` default.
 */
async function publishTarball(
  tarball: string,
  name: string,
  version: string,
  distTag: string | undefined,
): Promise<void> {
  const tagArgs = distTag === undefined ? [] : ['--tag', distTag]
  for (let tries = 1; tries <= PUBLISH_ATTEMPTS; tries += 1) {
    // No --access: every release member declares its own publishConfig, and
    // a command-line flag would override it. check-workspace-constraints
    // requires a public access level on every release member.
    const publish = npmInvocation(['publish', tarball, ...tagArgs])
    const result = attemptEchoed(publish.command, publish.args)
    const output = `${result.stdout}${result.stderr}`
    const packed = integrityOf(tarball)
    if (result.status === 0) {
      // The exit status is not publication. The registry acknowledges an upload
      // before the version it carries can be read, and npm reports that
      // acknowledgement as success, so a version is only published once the
      // registry says it carries these bytes. Confirming it here is what keeps
      // one release's two halves from disagreeing: the release asset step runs
      // next, and it cannot be undone once it has.
      const settled = await awaitRegistryState(name, version)
      if (settled.kind === 'absent') {
        throw new Error(
          `the registry accepted npm publish ${name}@${version} but does not carry it`
          + `\n  after ${String(SETTLE_TIMEOUT_MS / 1000)}s it still answers 404, while npm reported`
          + '\n  "Your package is being processed and may take a few minutes to become available."'
          + '\nThe upload was acknowledged without being published. Re-run this step: the'
          + '\n  registry skips a version it already carries, so re-running is safe.',
        )
      }
      if (settled.integrity !== packed) {
        throw new Error(
          `${name}@${version} is on the registry with content this release did not upload`
          + `\n  registry: ${settled.integrity}\n  packed:   ${packed}`,
        )
      }
      return
    }

    // A failed write can still have landed, and the retry that follows would
    // then be publishing a version the registry already holds, which fails
    // permanently. The probe is short because every attempt pays it.
    const settled = await awaitRegistryState(name, version, { timeoutMs: FAILED_UPLOAD_PROBE_MS })
    if (settled.kind === 'present' && settled.integrity === packed) {
      console.log(`release publish: ${name}@${version} landed despite a reported failure, continuing`)
      return
    }
    if (tries === PUBLISH_ATTEMPTS || !isTransientFailure(output)) {
      // The manifest is read here rather than up front because only this path
      // has a use for it, and reading one is a `tar` per release member. The
      // hint returns nothing for a failure that is not about credentials.
      const hint = registryAuthHint({ output, environment: process.env, manifest: packedManifest(tarball) })
      throw new Error(`npm publish ${name}@${version} failed:\n${output}${hint === undefined ? '' : `\n${hint}`}`)
    }
    const backoff = PUBLISH_SPACING_MS * 2 ** (tries - 1)
    console.log(
      `release publish: ${name}@${version} hit a transient registry failure`
      + ` (attempt ${String(tries)} of ${String(PUBLISH_ATTEMPTS)}), retrying in ${String(backoff)}ms`,
    )
    await sleep(backoff)
  }
}

/** Publish the family named by `--family` from the directory named by `--from`. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { family: { type: 'string' }, from: { type: 'string' } },
    allowPositionals: false,
  })
  if (values.family === undefined || values.from === undefined) {
    throw new Error('usage: publish.ts --family <dsh|freecodego|vendor> --from <packed directory>')
  }

  const family = releaseFamily(values.family)
  const directory = resolve(process.cwd(), values.from)

  // Every entry in the order settles as either published or already present, so
  // one counter answers "how far along is this run" for whoever is watching a
  // release that takes minutes per family.
  const order = readPublishOrder(directory)
  const total = String(order.length)
  let published = 0
  let skipped = 0
  for (const [index, filename] of order.entries()) {
    const progress = `[${String(index + 1)}/${total}]`
    const tarball = join(directory, filename)
    const { name, version } = packedIdentity(tarball)
    const state = registryState(name, version)
    if (state.kind === 'present') {
      const local = integrityOf(tarball)
      if (state.integrity !== local) {
        throw new Error(
          `${name}@${version} is already published with different content`
          + `\n  registry: ${state.integrity}\n  packed:   ${local}`
          + '\nBump the version, or investigate why the build is not reproducible.',
        )
      }
      console.log(`release publish: ${progress} ${name}@${version} already published, skipping`)
      skipped += 1
      continue
    }
    // Space out the writes: the gap belongs between publishes, so a run that
    // only skips does not wait at all.
    if (published > 0) await sleep(PUBLISH_SPACING_MS)
    await publishTarball(tarball, name, version, family.distTagForVersion(version))
    console.log(`release publish: ${progress} ${name}@${version} published`)
    published += 1
  }

  console.log(
    `release publish: family ${family.id}, ${total} member(s),`
    + ` ${String(published)} published, ${String(skipped)} already present`,
  )
}

if (isEntry(import.meta.url)) await main()
