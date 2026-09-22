/**
 * Reading a version's state from the registry, and waiting for one to settle.
 *
 * Publishing is not a read-after-write: the registry acknowledges an upload
 * before the version it carries is installable, and npm's own output says so —
 *
 *   Your package is being processed and may take a few minutes to become available.
 *
 * `npm publish` exits 0 on that acknowledgement, so a step that treats the exit
 * status as publication reports success against a version nobody can install,
 * and a step that reads the registry once reports a failure against a version
 * that is still on its way. Both are answered the same way: ask the registry
 * what it carries, and keep asking until it settles
 * ([rationale](../../.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md)).
 */

import { setTimeout as sleep } from 'node:timers/promises'
import { npmInvocation } from '../pnpm-invocation.ts'
import { attempt } from './process.ts'

/** What the registry knows about one version. */
export type RegistryState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly integrity: string }

/**
 * How long a version the registry has acknowledged is given to become readable.
 *
 * The registry's own message promises "a few minutes", so the budget is one and
 * a half of those: long enough that a slow registry is not reported as a failed
 * release, short enough that a release which will never appear does not hold a
 * job open indefinitely.
 */
export const SETTLE_TIMEOUT_MS = 180_000

/** Gap between two registry reads while waiting for a version to settle. */
export const SETTLE_INTERVAL_MS = 5_000

/**
 * How long a version is given to appear after an upload that reported failure.
 *
 * The same race as {@link SETTLE_TIMEOUT_MS} in the opposite direction: a write
 * that landed but has not settled makes the retry loop publish a version the
 * registry already holds, which fails permanently. The probe is short because
 * every attempt pays it before deciding whether to retry.
 */
export const FAILED_UPLOAD_PROBE_MS = 30_000

/**
 * Ask the registry whether a version exists, and with what integrity.
 * @param name - package name.
 * @param version - package version.
 * @returns The registry state for that version.
 */
export function registryState(name: string, version: string): RegistryState {
  const view = npmInvocation(['view', `${name}@${version}`, 'dist.integrity', '--json'])
  const result = attempt(view.command, view.args)
  if (result.status !== 0) {
    const output = `${result.stdout}${result.stderr}`
    if (output.includes('E404') || output.includes('404 Not Found')) return { kind: 'absent' }
    throw new Error(`npm view ${name}@${version} failed:\n${output}`)
  }
  const parsed: unknown = JSON.parse(result.stdout)
  if (typeof parsed !== 'string' || parsed === '') {
    throw new Error(`registry reported no dist.integrity for ${name}@${version}`)
  }
  return { kind: 'present', integrity: parsed }
}

/** How a wait reads the registry, and how long it waits — injectable so a spec can drive it. */
export interface SettleOptions {
  /** Total budget for the version to become readable. */
  readonly timeoutMs?: number
  /** Gap between two reads. */
  readonly intervalMs?: number
  /** The read itself, defaulting to {@link registryState}. */
  readonly read?: (name: string, version: string) => RegistryState
}

/**
 * Ask the registry what it carries, and keep asking until the version appears.
 * @param name - package name.
 * @param version - package version.
 * @param options - budget, gap, and the read to use.
 * @returns The registry state at the end of the wait, which may still be absent.
 */
export async function awaitRegistryState(
  name: string,
  version: string,
  options: SettleOptions = {},
): Promise<RegistryState> {
  const timeoutMs = options.timeoutMs ?? SETTLE_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? SETTLE_INTERVAL_MS
  const read = options.read ?? registryState
  const deadline = Date.now() + timeoutMs
  let state = read(name, version)
  while (state.kind === 'absent' && Date.now() < deadline) {
    await sleep(intervalMs)
    state = read(name, version)
  }
  return state
}
