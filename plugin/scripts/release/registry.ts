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
 * npm's message promises "a few minutes" and the registry means it: reading the
 * packument's own `time` entry for the two releases whose publish step had to be
 * re-run puts the version becoming readable 316s and 375s after that step
 * invoked npm — both of them past the 180s this budget used to be, which is why
 * each of those releases ended in a red run and a human pressing "Re-run jobs".
 *
 * Fifteen minutes is two and a half times the slower of those two measurements:
 * long enough that a registry having a slow afternoon is waited out rather than
 * reported as a failed release, short enough that a release which will never
 * appear does not hold a job open indefinitely.
 */
export const SETTLE_TIMEOUT_MS = 900_000

/** Gap between two registry reads while waiting for a version to settle. */
export const SETTLE_INTERVAL_MS = 5_000

/**
 * How often a wait that is still running says so.
 *
 * This budget is minutes long, and a step that prints nothing for six of them
 * reads like a hung job — which is how a wait gets cancelled and re-run by hand,
 * the outcome waiting exists to avoid. One line a minute keeps the step visibly
 * alive without burying what npm itself printed.
 */
export const SETTLE_REPORT_MS = 60_000

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

/** How a wait reads the registry, reports itself, and how long it waits — injectable so a spec can drive it. */
export interface SettleOptions {
  /** Total budget for the version to become readable. */
  readonly timeoutMs?: number
  /** Gap between two reads. */
  readonly intervalMs?: number
  /** Gap between two "still waiting" reports. */
  readonly reportEveryMs?: number
  /** Where a report goes, defaulting to standard output. */
  readonly report?: (message: string) => void
  /** The read itself, defaulting to {@link registryState}. */
  readonly read?: (name: string, version: string) => RegistryState
}

/**
 * Ask the registry what it carries, and keep asking until the version appears.
 *
 * A wait that has to happen is announced before it starts and then once a
 * {@link SETTLE_REPORT_MS} while it runs, because the caller that started this
 * is a CI step whose only sign of life is what it prints.
 * @param name - package name.
 * @param version - package version.
 * @param options - budget, gaps, where reports go, and the read to use.
 * @returns The registry state at the end of the wait, which may still be absent.
 */
export async function awaitRegistryState(
  name: string,
  version: string,
  options: SettleOptions = {},
): Promise<RegistryState> {
  const timeoutMs = options.timeoutMs ?? SETTLE_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? SETTLE_INTERVAL_MS
  const reportEveryMs = options.reportEveryMs ?? SETTLE_REPORT_MS
  const report = options.report ?? ((message: string): void => { console.log(message) })
  const read = options.read ?? registryState
  const started = Date.now()
  const deadline = started + timeoutMs
  const seconds = (milliseconds: number): string => String(Math.round(milliseconds / 1000))
  let state = read(name, version)
  if (state.kind === 'absent') {
    report(`registry: ${name}@${version} is not readable yet; waiting up to ${seconds(timeoutMs)}s for it to appear`)
  }
  let nextReport = started + reportEveryMs
  while (state.kind === 'absent' && Date.now() < deadline) {
    await sleep(intervalMs)
    state = read(name, version)
    if (state.kind === 'absent' && Date.now() >= nextReport) {
      report(
        `registry: ${name}@${version} is still not readable,`
        + ` ${seconds(Date.now() - started)}s into a ${seconds(timeoutMs)}s wait`,
      )
      nextReport = Date.now() + reportEveryMs
    }
  }
  return state
}
