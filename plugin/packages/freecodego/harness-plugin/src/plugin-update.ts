/**
 * Host-owned update checks and profile installation for the FreeCodeGo package.
 *
 * Two decisions shape this module, and both are departures from the npm path
 * it replaced:
 *
 * 1. The check reads **GitHub Releases**, not a registry packument. A published
 *    version can be withdrawn by editing the release, which a published npm
 *    version cannot — npm forbids reusing a version and only allows unpublishing
 *    inside a 72-hour window, so a bad release could only ever be covered by a
 *    new release. The release tag also carries the compatibility answer, so one
 *    request settles both questions.
 * 2. Installation runs the **`dsh plugin` command**, the same entry point the
 *    user installed with. It owns the profile-addressing rules, the pnpm
 *    invocation, and the `dsh.profile.bundles` reconciliation that decides
 *    whether the freshly installed package is actually a profile layer. Running
 *    `pnpm` directly skipped that reconciliation entirely.
 */

import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type { FreeCodeGoSettingsPort } from './policy.ts'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { harnessHomeDirectory } from './data-home.ts'
import { redactCredentialShapes } from './secret-scan.ts'
import type { FreeCodeGoPluginUpdateStatus } from './types.ts'

/** The published bundle is the only supported automatic-update target. */
export const FREECODEGO_UPDATE_PACKAGE = 'freecodego'

/**
 * Repository whose releases are the update source.
 *
 * The convention this module depends on: a release exists only for a Harness
 * line, and its tag names the version, so `v0.1.3-alpha.1` means "the bundle for
 * Harness `0.1.3-alpha.1`". {@link bundleReleaseForHarness} reads the version
 * straight out of that tag, which is why a check needs no manifest and no second
 * request. The release family prefixes its tags with `freecodego-` — one
 * repository carries more than one family's releases — and the prefixed form is
 * what the publishing workflow creates, so both spellings are read.
 */
export const FREECODEGO_RELEASE_REPOSITORY = 'XiangSu-ce/dsh-plugin-freecodego'

const GITHUB_RELEASES_PAGE_SIZE = 30
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000
const STARTUP_DELAY_MS = 15_000
const REQUEST_TIMEOUT_MS = 15_000
const MAX_RELEASES_BYTES = 2_000_000
const MAX_UNCONFIRMED_STARTUPS = 2
/** Cap one install so a stalled package-manager run cannot leave the update stuck in `installing` forever. */
const DSH_INSTALL_TIMEOUT_MS = 15 * 60_000
const NPM_PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i
/**
 * A release tag that names a bundle version, with the family prefix optional.
 *
 * `freecodego-v0.1.7-alpha.2` is what `release:freecodego` tags and what the
 * publishing workflow creates its release from; `v0.1.7-alpha.2` is accepted
 * because a release created under the bare form is still a release for the same
 * Harness line, and refusing it would hide an installable update. Any other
 * prefix — another family's tag — is not this bundle.
 */
const RELEASE_TAG_RE = /^(?:freecodego-)?v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u


interface GitHubReleaseAsset {
  readonly name?: unknown
  readonly browser_download_url?: unknown
  readonly size?: unknown
}

interface GitHubRelease {
  readonly tag_name?: unknown
  readonly draft?: unknown
  readonly html_url?: unknown
  readonly published_at?: unknown
  readonly assets?: unknown
}

/** One release the running Harness is allowed to install. */
export interface FreeCodeGoBundleRelease {
  readonly version: string
  readonly tag: string
  readonly pageUrl: string
  readonly tarballUrl: string
  readonly publishedAt?: string
}

interface UpdateServiceOptions {
  readonly settings: FreeCodeGoSettingsPort | undefined
  readonly packageName?: string
  readonly releaseRepository?: string
  readonly releaseTokenEnv?: string
  /** Explicit profile location used by isolated profile tests and Desktop embedding. */
  readonly profilePath?: string
  /**
   * Test seam for the profile-local `dsh plugin` invocation. `args` are the
   * arguments after `plugin --profile <profile>`, so a test never has to
   * reproduce the profile addressing the CLI owns.
   */
  readonly runDsh?: (profile: string, args: readonly string[]) => Promise<{ readonly code: number; readonly detail: string }>
}

/**
 * Manage FreeCodeGo's published bundle without exposing release credentials or
 * package-manager details to the browser.
 */
export class FreeCodeGoPluginUpdateService {
  private readonly packageName: string
  private readonly releaseRepository: string
  private readonly releaseTokenEnv: string
  private readonly profilePath: string
  private readonly profileName: string
  private readonly dsh: (profile: string, args: readonly string[]) => Promise<{ readonly code: number; readonly detail: string }>
  private readonly localInstall: boolean
  /**
   * Asset URL the last check selected.
   *
   * Held rather than rebuilt at install time: the check is what proved the
   * asset exists, and a URL constructed from a naming convention would be a
   * second, independent guess at the same thing.
   */
  private releaseTarball: string | undefined
  private statusValue: FreeCodeGoPluginUpdateStatus
  private checkTask: Promise<FreeCodeGoPluginUpdateStatus> | undefined
  private installTask: Promise<FreeCodeGoPluginUpdateStatus> | undefined
  private startupTimer: NodeJS.Timeout | undefined
  private intervalTimer: NodeJS.Timeout | undefined
  private readonly recoveryTask: Promise<void>

  constructor(private readonly options: UpdateServiceOptions) {
    const location = profileLocation()
    this.packageName = validPackageName(options.packageName) ? options.packageName!.trim() : FREECODEGO_UPDATE_PACKAGE
    this.releaseRepository = validRepository(options.releaseRepository) ? options.releaseRepository!.trim() : FREECODEGO_RELEASE_REPOSITORY
    this.releaseTokenEnv = validEnvName(options.releaseTokenEnv) ? options.releaseTokenEnv!.trim() : ''
    this.profilePath = options.profilePath ?? location.directory
    this.profileName = options.profilePath === undefined ? location.name : basename(resolve(options.profilePath))
    this.dsh = options.runDsh ?? runDsh
    this.localInstall = isLocalProfileDependency(this.profilePath, this.packageName)
    const currentVersion = readCurrentVersion(this.packageName, this.profilePath)
    const harnessVersion = readHarnessVersion(this.profilePath)
    const harnessBaseline = readBundleBaseline(this.profilePath, this.packageName)
    const pending = readPendingUpdateMarker(this.profilePath)
    this.recoveryTask = (pending !== undefined && pending.processId !== process.pid ? preparePendingUpdateStartup(this.profilePath, pending) : Promise.resolve())
      .then(() => sweepOrphanBackupDirectories(this.profilePath, pending?.backupDirectory))
      .catch(() => undefined)
    this.statusValue = {
      enabled: options.settings?.get()?.pluginUpdateChecksEnabled !== false,
      packageName: this.packageName,
      currentVersion,
      installation: this.localInstall ? 'local' : 'release',
      releaseRepository: this.releaseRepository,
      ...(harnessVersion === undefined ? {} : { harnessVersion }),
      ...(harnessBaseline === undefined ? {} : { harnessBaseline }),
      phase: 'idle',
      restartRequired: false,
      ...(pending === undefined ? {} : { rollbackPending: true, rollbackReason: 'A previous update is awaiting startup confirmation.' }),
    }
  }

  /** Start the unref'd periodic check used by desktop and web Hosts alike. */
  start(): void {
    if (this.startupTimer !== undefined) return
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined
      void this.recoveryTask.then(() => this.check(false)).catch(() => undefined)
    }, STARTUP_DELAY_MS)
    this.startupTimer.unref?.()
    this.intervalTimer = setInterval(() => void this.check(false), CHECK_INTERVAL_MS)
    this.intervalTimer.unref?.()
  }

  /** Stop timers during Host disposal. */
  stop(): void {
    if (this.startupTimer !== undefined) clearTimeout(this.startupTimer)
    if (this.intervalTimer !== undefined) clearInterval(this.intervalTimer)
    this.startupTimer = undefined
    this.intervalTimer = undefined
  }

  /** Return the latest redacted update state. 
   * @returns the plugin Update Status.
   */
  status(): FreeCodeGoPluginUpdateStatus {
    const enabled = this.options.settings?.get()?.pluginUpdateChecksEnabled !== false
    return { ...this.statusValue, enabled }
  }

  /** Persist the automatic-check switch. 
   * @param enabled - whether this capability is switched on.
   * @returns the plugin Update Status.
   */
  async setEnabled(enabled: boolean): Promise<FreeCodeGoPluginUpdateStatus> {
    if (typeof enabled !== 'boolean') throw new Error('plugin update checks enabled must be a boolean')
    await this.options.settings?.update({ pluginUpdateChecksEnabled: enabled })
    this.statusValue = { ...this.statusValue, enabled }
    return this.status()
  }

  /** Check the release repository for a newer bundle built for this Harness. 
   * @returns the plugin Update Status.
 * @param manual - whether the user asked for the check, which ignores the enabled flag.
   */
  async check(manual: boolean): Promise<FreeCodeGoPluginUpdateStatus> {
    await this.recoveryTask
    if (!manual && ! this.status().enabled) return this.status()
    if (this.checkTask !== undefined) return this.checkTask
    const task = this.checkImpl()
    this.checkTask = task
    try { return await task } finally {
      if (this.checkTask === task) this.checkTask = undefined
    }
  }

  /** Install the selected release into the active profile. 
   * @returns the plugin Update Status.
   */
  async install(): Promise<FreeCodeGoPluginUpdateStatus> {
    await this.recoveryTask
    if (this.installTask !== undefined) return this.installTask
    const task = this.installImpl()
    this.installTask = task
    try { return await task } finally {
      if (this.installTask === task) this.installTask = undefined
    }
  }

  /** A successful Host initialization confirms the installed update and discards its recovery point. 
   * @returns the plugin Update Status.
   */
  async confirmStartup(): Promise<FreeCodeGoPluginUpdateStatus> {
    await this.recoveryTask
    const pending = readPendingUpdateMarker(this.profilePath)
    if (pending === undefined) return this.status()
    if (pending.promoting === true) {
      // The install never reported success, so the recovery point is the last
      // profile state known to be consistent.
      await restoreRecoveryPoint(this.profilePath, pending.backupDirectory)
      await rm(pendingUpdateMarkerPath(this.profilePath), { force: true })
      this.statusValue = { ...this.statusValue, phase: 'error', restartRequired: true, rollbackPending: false, rollbackReason: 'The previous update did not finish installing. The last good manifests were restored; restart Harness to continue.' }
      return this.status()
    }
    // A session started by the process that performed the install proves the
    // old bundle still runs, not the new one, and must not discard the recovery
    // point. Only a restarted process running the target version confirms it.
    const updatedLive = pending.processId !== process.pid
      && readCurrentVersion(this.packageName, this.profilePath) === pending.targetVersion
    if (!updatedLive) return this.status()
    assertInsideProfileRoot(this.profilePath, pending.backupDirectory)
    await rm(pending.backupDirectory, { recursive: true, force: true })
    await rm(pendingUpdateMarkerPath(this.profilePath), { force: true })
    const { rollbackReason: _reason, ...clean } = this.statusValue
    this.statusValue = { ...clean, restartRequired: false, rollbackPending: false }
    return this.status()
  }

  /** Restore the previous profile manifests before the next restart. 
   * @returns the plugin Update Status.
   */
  async rollback(): Promise<FreeCodeGoPluginUpdateStatus> {
    await this.recoveryTask
    const pending = readPendingUpdateMarker(this.profilePath)
    if (pending === undefined) throw new Error('no pending FreeCodeGo update rollback exists')
    await restoreRecoveryPoint(this.profilePath, pending.backupDirectory)
    await rm(pendingUpdateMarkerPath(this.profilePath), { force: true })
    this.statusValue = { ...this.statusValue, phase: 'error', restartRequired: true, rollbackPending: false, rollbackReason: 'The previous update was restored. Restart Harness to continue.' }
    return this.status()
  }

  /**
   * Run one check. Whether a disabled install may still be checked is decided by
   * {@link check} before it gets here.
   */
  private async checkImpl(): Promise<FreeCodeGoPluginUpdateStatus> {
    const { error: _checkError, ...withoutCheckError } = this.statusValue
    this.publishFromCheck({ ...withoutCheckError, phase: 'checking' })
    if (this.localInstall) {
      this.publishFromCheck({
        ...this.statusValue,
        phase: 'up-to-date',
        latestVersion: this.statusValue.currentVersion,
        checkedAt: Date.now(),
      })
      return this.status()
    }
    const harnessVersion = this.packageName === FREECODEGO_UPDATE_PACKAGE ? readHarnessVersion(this.profilePath) : undefined
    if (this.packageName === FREECODEGO_UPDATE_PACKAGE && harnessVersion === undefined) {
      this.publishFromCheck({ ...this.statusValue, phase: 'incompatible', checkedAt: Date.now(), error: 'active Harness version could not be detected' })
      return this.status()
    }
    if (harnessVersion !== undefined) this.publishFromCheck({ ...this.statusValue, harnessVersion })
    try {
      const releases = await fetchReleases(this.releaseRepository, this.releaseTokenEnv)
      const release = bundleReleaseForHarness(releases, harnessVersion, this.packageName)
      if (release === undefined) {
        this.releaseTarball = undefined
        const { latestVersion: _latestVersion, releaseUrl: _releaseUrl, ...withoutRelease } = this.statusValue
        this.publishFromCheck({ ...withoutRelease, phase: 'incompatible', checkedAt: Date.now() })
        return this.status()
      }
      this.releaseTarball = release.tarballUrl
      // Compared against the version the profile reports *now* rather than the
      // one this check started with: an install that finished while the request
      // was in flight has already recorded what it placed, and reading that as an
      // update would put the Install button back on a version already installed.
      const update = compareVersions(release.version, this.statusValue.currentVersion) > 0
      this.publishFromCheck({
        ...this.statusValue,
        phase: update ? 'available' : 'up-to-date',
        latestVersion: release.version,
        releaseUrl: release.pageUrl,
        checkedAt: Date.now(),
      })
    } catch (error) {
      this.publishFromCheck({
        ...this.statusValue,
        phase: 'error',
        checkedAt: Date.now(),
        // The release source is fetched with an optional token, and the status
        // this publishes is shown until the next attempt.
        error: redactCredentialShapes(error instanceof Error ? error.message : String(error)),
      })
    }
    return this.status()
  }

  /**
   * Publish a status a check computed, unless an install owns it right now.
   *
   * Checks run on their own schedule — the periodic timer fires whether or not
   * the user is installing — so the two overlap: a check that started before an
   * install can still be waiting on the release source when the install writes
   * its result. Only the install knows the phase and the restart the profile is
   * in, and it also holds the verified version, so a check publishes nothing
   * while one is in flight instead of reverting `installing` (and, through the
   * snapshot it captured at its own start, the restart prompt) to what the state
   * was before the install began.
   */
  private publishFromCheck(next: FreeCodeGoPluginUpdateStatus): void {
    if (this.installTask === undefined) this.statusValue = next
  }

  private async installImpl(): Promise<FreeCodeGoPluginUpdateStatus> {
    const current = this.status()
    if (current.latestVersion === undefined || compareVersions(current.latestVersion, current.currentVersion) <= 0) {
      throw new Error('no newer FreeCodeGo version is available')
    }
    // Set by the check that produced `latestVersion`; an install without a
    // preceding check has nothing to install.
    const tarballUrl = this.releaseTarball
    if (tarballUrl === undefined) throw new Error('the selected FreeCodeGo release has no installable tarball')
    const profile = this.profilePath
    const packageJson = join(profile, 'package.json')
    if (!existsSync(packageJson)) throw new Error('FreeCodeGo profile is not initialized')
    const { error: _installError, ...withoutInstallError } = current
    this.statusValue = { ...withoutInstallError, phase: 'installing' }
    // The recovery point is taken before anything touches the profile, and it is
    // the two manifests only: `pnpm` writes the new version into `node_modules`
    // only after it has fetched it, so restoring them is what makes a failed
    // install retryable without moving a directory the size of the profile.
    // Both steps below run *before* the package manager does, and both can
    // fail (a read-only profile directory, a full disk, a lock) — so a failure
    // here has to publish an `error` status exactly like every later failure
    // does. The phase is already `installing` by this point and the caller only
    // ever sees the rejection, so a bare `throw` would leave a spinner that
    // nothing replaces until the next scheduled check, hours later.
    let recovery: string | undefined
    let marker: PendingUpdateMarker
    try {
      recovery = await createRecoveryPoint(profile)
      marker = {
        version: 1,
        packageName: this.packageName,
        targetVersion: current.latestVersion,
        backupDirectory: recovery,
        attempts: 0,
        processId: process.pid,
        promoting: true,
      }
      // Written before the profile is touched: a crash mid-install leaves a
      // promoting marker behind so the next startup restores the manifests.
      await writePendingUpdateMarker(profile, marker)
    } catch (error) {
      if (recovery !== undefined) await rm(recovery, { recursive: true, force: true })
      const detail = error instanceof Error ? error.message : String(error)
      this.statusValue = { ...this.statusValue, phase: 'error', error: detail }
      throw error instanceof Error ? error : new Error(detail)
    }
    // What the profile holds once this install returns: the version it reports
    // when the install succeeded, the previous one when it failed and the
    // recovery point was restored.
    let installedVersion = current.currentVersion
    try {
      const result = await this.dsh(this.profileName, ['add', '--save-exact', tarballUrl])
      // Masked, because this text is stored in the update status and shown until
      // the next attempt: the install resolves a tarball URL, and a registry that
      // refuses the fetch echoes the request it refused — including the token a
      // configured registry carries in that URL.
      if (result.code !== 0) throw new Error(redactCredentialShapes(result.detail))
      // Verify what actually landed rather than what was asked for. A registry
      // mirror, a proxy, or a release whose asset was replaced can all resolve a
      // request to something other than the requested version, and reporting
      // success on that would leave the user on an unexpected build.
      const installed = readCurrentVersion(this.packageName, profile)
      if (installed !== current.latestVersion) {
        throw new Error(`installed FreeCodeGo ${installed} instead of ${current.latestVersion}`)
      }
      installedVersion = installed
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      // A rollback that fails is the *dangerous* outcome, not a footnote: the
      // install already touched the profile, so a half-restored package.json /
      // pnpm-lock.yaml pair is what the next start would read. Two things follow
      // from that. The failure is reported instead of replaced by the install
      // error alone, and the marker stays — its `promoting` branch is the only
      // retry (`restoreRecoveryPoint` keeps the retained manifests), and the
      // orphan sweep deletes an unmarked recovery point an hour later.
      const rollback = await restoreRecoveryPoint(profile, recovery).then(
        () => undefined,
        (failure: unknown) => failure instanceof Error ? failure.message : String(failure),
      )
      if (rollback === undefined) await rm(pendingUpdateMarkerPath(profile), { force: true })
      const message = rollback === undefined
        ? detail
        : `${detail} (the previous versions could not be restored: ${rollback}; they are restored on the next start)`
      this.statusValue = { ...this.statusValue, phase: 'error', error: message }
      throw new Error(message)
    }
    // The install succeeded; the marker now only guards an unconfirmed restart.
    // A failed rewrite must be retried in-process before giving up: if it still
    // reads `promoting: true` after a restart, confirmStartup would roll back
    // the freshly installed version.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await writePendingUpdateMarker(profile, { ...marker, promoting: false })
        break
      } catch (markerError) {
        // Final failure keeps the marker stale; the next install clears it and
        // confirmStartup's recovery path still holds the prior manifests.
        if (attempt === 2) this.statusValue = { ...this.statusValue, error: markerError instanceof Error ? `update marker rewrite failed: ${redactCredentialShapes(markerError.message)}` : 'update marker rewrite failed' }
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)))
      }
    }
    const { error: _completedError, ...withoutCompletedError } = this.statusValue
    // The profile now holds the version the check selected, which is exactly
    // what the next check reads out of the same manifest, so the two agree the
    // moment it runs. Reporting it here is what stops the card from offering the
    // release it just installed: `available` alongside a version already on disk
    // renders an Install button whose only outcome is "no newer version is
    // available", after re-running the whole package-manager install.
    this.statusValue = {
      ...withoutCompletedError,
      currentVersion: installedVersion,
      phase: 'up-to-date',
      restartRequired: true,
      rollbackPending: true,
      rollbackReason: 'Restart Harness to activate the update; the previous manifests are retained until startup succeeds.',
    }
    return this.status()
  }
}

function profileLocation(): { readonly name: string; readonly directory: string } {
  const index = process.argv.indexOf('--profile')
  const name = index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1]! : 'web'
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error('profile name is invalid')
  return { name, directory: join(harnessHomeDirectory(), 'profiles', name) }
}

function readCurrentVersion(packageName: string, profile: string): string {
  try {
    const manifestPath = join(profile, 'node_modules', ...packageName.split('/'), 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : '0.0.0'
  } catch {
    try {
      const require = createRequire(import.meta.url)
      const manifest = require(`${packageName}/package.json`) as { version?: unknown }
      return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : '0.0.0'
    } catch { return '0.0.0' }
  }
}

/** Local `link:` and `file:` profile dependencies are rebuilt in-place, not updated through a release. */
function isLocalProfileDependency(profile: string, packageName: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as { dependencies?: unknown }
    if (manifest.dependencies === null || typeof manifest.dependencies !== 'object' || Array.isArray(manifest.dependencies)) return false
    const specifier = (manifest.dependencies as Record<string, unknown>)[packageName]
    return typeof specifier === 'string' && (specifier.startsWith('link:') || specifier.startsWith('file:'))
  } catch {
    return false
  }
}

function readManifest(profile: string, packageName: string): PackageManifest | undefined {
  try {
    const manifestPath = join(profile, 'node_modules', ...packageName.split('/'), 'package.json')
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest
  } catch { return undefined }
}

/** Detect the official Harness line from the active profile's base bundle. */
function readHarnessVersion(profile: string): string | undefined {
  for (const packageName of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh']) {
    const value = readManifest(profile, packageName)?.version
    if (typeof value === 'string' && isSemver(value)) return value
  }
  return undefined
}

function readBundleBaseline(profile: string, packageName: string): string | undefined {
  const baseline = readManifest(profile, packageName)?.freecodego?.harnessBaseline
  return typeof baseline === 'string' ? baseline : undefined
}

interface PackageManifest {
  readonly version?: unknown
  readonly freecodego?: { readonly harnessBaseline?: unknown }
}

function pendingUpdateMarkerPath(profile: string): string { return join(profile, '.dsh-freecodego-update-pending.json') }

function readPendingUpdateMarker(profile: string): PendingUpdateMarker | undefined {
  try {
    const value = JSON.parse(readFileSync(pendingUpdateMarkerPath(profile), 'utf8')) as Partial<PendingUpdateMarker>
    if (value.version !== 1 || typeof value.packageName !== 'string' || typeof value.targetVersion !== 'string' || typeof value.backupDirectory !== 'string' || !Number.isSafeInteger(value.attempts) || !Number.isSafeInteger(value.processId)) return undefined
    return value as PendingUpdateMarker
  } catch { return undefined }
}

/** Recover a pending update on the first startup of a new process. */
async function preparePendingUpdateStartup(profile: string, marker: PendingUpdateMarker): Promise<void> {
  if (marker.promoting === true) {
    // The install never completed; the retained manifests are the last state
    // known to be consistent.
    await restoreRecoveryPoint(profile, marker.backupDirectory)
    await rm(pendingUpdateMarkerPath(profile), { force: true })
    return
  }
  // This service only runs from the installed profile, so the on-disk version
  // matching the target proves the new bundle booted: confirmation is complete
  // and a user who never opens a session still keeps the update.
  if (readCurrentVersion(marker.packageName, profile) === marker.targetVersion) {
    assertInsideProfileRoot(profile, marker.backupDirectory)
    await rm(marker.backupDirectory, { recursive: true, force: true }).catch(() => undefined)
    await rm(pendingUpdateMarkerPath(profile), { force: true })
    return
  }
  const nextAttempts = marker.attempts + 1
  if (nextAttempts >= MAX_UNCONFIRMED_STARTUPS) {
    await restoreRecoveryPoint(profile, marker.backupDirectory)
    await rm(pendingUpdateMarkerPath(profile), { force: true })
    return
  }
  await writePendingUpdateMarker(profile, { ...marker, attempts: nextAttempts })
}

/**
 * Publish the pending-update marker in one atomic step: stage the JSON in a
 * sibling and rename it over the target.
 *
 * A direct write to the marker path is not equivalent. The marker *is* the
 * transaction log for an update: `promoting: true` is what tells the next
 * startup to restore the retained manifests, and its absence after a completed
 * install is what tells the next startup the new bundle is live. A process that
 * dies mid-write — or a disk that fills — leaves a truncated document at that
 * path, so the next boot would read the update's own recovery instructions out
 * of a half-written file. The rename is what makes the marker appear only once
 * it is whole.
 *
 * The per-write random suffix keeps two writers (an install and a startup
 * recovery in another process) from sharing one staging path, and `wx` refuses
 * to follow a symlink planted there. Both mirror `writeGeneratedMedia` in
 * `media-generation.ts`.
 */
async function writePendingUpdateMarker(profile: string, marker: PendingUpdateMarker): Promise<void> {
  const file = pendingUpdateMarkerPath(profile)
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(marker)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
  } catch (error) {
    // A failure before the rename must not leave an orphan staging file behind;
    // the marker path still holds whatever it held before, so the caller sees a
    // clean failure. Cleanup is best-effort: a staging file this process cannot
    // remove must not replace the failure that actually stopped the write.
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Copy the profile manifests that an install can rewrite into a sibling
 * directory.
 *
 * Only the manifests are copied. Moving `node_modules` — what the npm-era
 * implementation did to stage a whole install beside the profile — costs a
 * directory rewrite on every update and buys nothing now that the install runs
 * in place: `pnpm` fetches the new version before it relinks, so a failed
 * install leaves the previous version's files on disk and the manifests are
 * what have to be put back.
 */
async function createRecoveryPoint(profile: string): Promise<string> {
  const directory = await mkdtemp(join(dirname(profile), `.${basename(profile)}-freecodego-backup-`))
  try {
    for (const name of RECOVERY_MANIFESTS) {
      const source = join(profile, name)
      if (existsSync(source)) await copyFile(source, join(directory, name))
    }
    return directory
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

/** Restore the manifests a recovery point holds and drop the directory. */
async function restoreRecoveryPoint(profile: string, recovery: string): Promise<void> {
  assertInsideProfileRoot(profile, recovery)
  for (const name of RECOVERY_MANIFESTS) {
    const previous = join(recovery, name)
    if (existsSync(previous)) await copyFile(previous, join(profile, name))
  }
  await rm(recovery, { recursive: true, force: true })
}

/** Profile files an install can rewrite. */
const RECOVERY_MANIFESTS = ['package.json', 'pnpm-lock.yaml'] as const

/**
 * Marker-derived paths drive rm -rf; refuse anything this module did not create.
 *
 * Being inside the profile *parent* is not sufficient. Every other profile, and
 * any user directory, lives there too, so a corrupted or hand-edited marker
 * naming one of them would have it deleted: `restoreRecoveryPoint` ends by
 * removing whatever the marker pointed at, and `preparePendingUpdateStartup`
 * deletes the same path on a confirmed update. Both prefixes below are the ones
 * this module has ever created — `update-` from the staged-install era and
 * `backup-` from now — so an in-flight profile from an older build is still
 * recoverable while nothing else is accepted.
 */
function assertInsideProfileRoot(profile: string, candidate: string): void {
  const prefix = resolve(dirname(profile), `.${basename(profile)}-freecodego-`)
  const resolved = resolve(candidate)
  const suffix = resolved.startsWith(prefix) ? resolved.slice(prefix.length) : ''
  // One path segment, no traversal: `update-XXXXXX` or `backup-XXXXXX`.
  if (!/^(?:update|backup)-[^\\/]+$/u.test(suffix)) throw new Error('update recovery point is outside the profile root')
}

const ORPHAN_MIN_AGE_MS = 60 * 60 * 1_000

/** Remove recovery directories left by a crashed install that no marker references. */
async function sweepOrphanBackupDirectories(profile: string, keepRecovery: string | undefined): Promise<void> {
  const parent = dirname(profile)
  const prefixes = [`.${basename(profile)}-freecodego-update-`, `.${basename(profile)}-freecodego-backup-`]
  const kept = keepRecovery === undefined ? undefined : resolve(keepRecovery)
  let names: string[]
  try { names = await readdir(parent) } catch { return }
  for (const name of names) {
    if (!prefixes.some(prefix => name.startsWith(prefix))) continue
    const candidate = join(parent, name)
    if (kept !== undefined && resolve(candidate) === kept) continue
    try {
      const info = await stat(candidate)
      if (Date.now() - info.mtimeMs < ORPHAN_MIN_AGE_MS) continue
      await rm(candidate, { recursive: true, force: true })
    } catch { /* in use or already gone */ }
  }
}

function validPackageName(value: string | undefined): boolean {
  return value !== undefined && NPM_PACKAGE_RE.test(value.trim())
}

function validEnvName(value: string | undefined): boolean {
  return value !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.trim())
}

/** `owner/repo` only: the check builds a GitHub API URL straight out of this. */
function validRepository(value: string | undefined): boolean {
  return value !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value.trim())
}

async function fetchReleases(repository: string, tokenEnv: string): Promise<readonly GitHubRelease[]> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'FreeCodeGo-Harness' }
  const token = tokenEnv === '' ? undefined : process.env[tokenEnv]?.trim()
  if (token !== undefined && token !== '') headers.authorization = token.startsWith('Bearer ') ? token : `Bearer ${token}`
  const response = await fetch(`${githubReleasesUrl(repository)}?per_page=${GITHUB_RELEASES_PAGE_SIZE}`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`release repository returned HTTP ${response.status}`)
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > MAX_RELEASES_BYTES) throw new Error('release response is too large')
  const body = await response.text()
  if (Buffer.byteLength(body, 'utf8') > MAX_RELEASES_BYTES) throw new Error('release response is too large')
  const parsed: unknown = JSON.parse(body)
  if (!Array.isArray(parsed)) throw new Error('release response is invalid')
  return parsed as readonly GitHubRelease[]
}

function githubReleasesUrl(repository: string): string {
  return `https://api.github.com/repos/${repository}/releases`
}

/**
 * The release asset name for one bundle version — the naming rule this plugin
 * and its release tooling share.
 *
 * `<package name>-<version>.tgz`, with a scope flattened the way a packed
 * tarball is named everywhere else in this repository: `@scope/name` becomes
 * `scope-name`, not `name`.
 * @param packageName - the package name, scoped or bare.
 * @param version - the bundle version.
 * @returns the release asset name.
 */
export function releaseAssetName(packageName: string, version: string): string {
  const unscoped = packageName.startsWith('@') ? packageName.slice(1).replace('/', '-') : packageName
  return `${unscoped}-${version}.tgz`
}

/**
 * The asset names one release may carry, most specific first.
 *
 * The published rule names the **Harness line**, because that is what a bundle
 * is built for and what a user needs to see in the file name: a hotfix release
 * tagged `v0.1.3-alpha.1.1` ships `freecodego-0.1.3-alpha.1.tgz` and takes its
 * exact version from the tag. The release version is accepted as well, because
 * that spelling is what `pnpm pack` writes and what an earlier publish step
 * produced — refusing a release over which of the two names the publisher used
 * is exactly the silent never-appearing update this lookup exists to avoid.
 *
 * With no Harness version in scope (a custom package name, whose line cannot be
 * read from the profile) the two collapse into one, as they already do for a
 * line's first release, where the version *is* the Harness version.
 * @param packageName - the package name, scoped or bare.
 * @param version - the release version.
 * @param harnessVersion - the Harness line, when it can be read from the profile.
 * @returns the acceptable asset names, most specific first.
 */
export function releaseAssetNames(packageName: string, version: string, harnessVersion: string | undefined): readonly string[] {
  const byHarness = harnessVersion === undefined ? [] : [releaseAssetName(packageName, harnessVersion)]
  return [...new Set([...byHarness, releaseAssetName(packageName, version)])]
}

/**
 * Pick the release the running Harness may install.
 *
 * Exported because this single function decides what a user is upgraded *to*,
 * and its failure modes are silent: offering a bundle built for another Harness
 * moves a user onto code whose imports do not resolve, and reading the version
 * out of the wrong place moves them onto a version that does not exist.
 *
 * The rules, in order:
 * - Drafts are skipped, and the tag has to be `v<semver>` — a release whose tag
 *   is not a version is not one this module created.
 * - A version is for this Harness when it equals the running Harness or extends
 *   it with a further dotted segment. That second form is the hotfix: the
 *   published bundle has to declare a `freecodego.harnessBaseline` equal to the
 *   running Harness, so more than one release per Harness line can only differ
 *   in the version, never in the baseline. Requiring an exact match instead
 *   would make a hotfix unreachable, which is the case the whole release channel
 *   exists to serve.
 * - The highest remaining version wins.
 *
 * @param releases - the repository's releases, as the API returned them.
 * @param harnessVersion - the running Harness version, when known.
 * @param packageName - the installed package name, for the expected asset name.
 * @returns the release to offer, or undefined when none is installable here.
 */
export function bundleReleaseForHarness(
  releases: readonly GitHubRelease[],
  harnessVersion: string | undefined,
  packageName: string = FREECODEGO_UPDATE_PACKAGE,
): FreeCodeGoBundleRelease | undefined {
  const candidates: FreeCodeGoBundleRelease[] = []
  for (const release of releases) {
    if (release.draft === true) continue
    const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
    const version = RELEASE_TAG_RE.exec(tag)?.[1]
    if (version === undefined) continue
    if (harnessVersion !== undefined && !isVersionForHarness(version, harnessVersion)) continue
    const tarballUrl = releaseAssetFor(release, version, packageName, harnessVersion)
    if (tarballUrl === undefined) continue
    candidates.push({
      version,
      tag,
      pageUrl: typeof release.html_url === 'string' ? release.html_url : `https://github.com/${FREECODEGO_RELEASE_REPOSITORY}/releases/tag/${tag}`,
      tarballUrl,
      ...(typeof release.published_at === 'string' ? { publishedAt: release.published_at } : {}),
    })
  }
  return candidates.sort((left, right) => compareVersions(right.version, left.version))[0]
}

/**
 * Whether a release version belongs to the line the running Harness is on.
 *
 * `0.1.3-alpha.1` is the first release of its Harness line and `0.1.3-alpha.1.1`
 * is a hotfix for it. The trailing dot in the prefix comparison is what keeps
 * `0.1.3-alpha.10` — a different line — out.
 */
function isVersionForHarness(version: string, harnessVersion: string): boolean {
  return version === harnessVersion || version.startsWith(`${harnessVersion}.`)
}

/**
 * The installable tarball a release carries for one version, if any.
 *
 * {@link releaseAssetNames} is tried in order, so the Harness-line name wins
 * over the release-version one. A single tarball under any other name is still
 * accepted: the URL comes from the release the check already selected, so
 * nothing is guessed, and refusing a release over an asset name would turn a
 * publisher's typo into an update that silently never appears.
 */
function releaseAssetFor(release: GitHubRelease, version: string, packageName: string, harnessVersion: string | undefined): string | undefined {
  if (!Array.isArray(release.assets)) return undefined
  const assets = (release.assets as readonly GitHubReleaseAsset[]).filter(asset => typeof asset.browser_download_url === 'string')
  for (const expected of releaseAssetNames(packageName, version, harnessVersion)) {
    const named = assets.find(asset => asset.name === expected)
    if (named !== undefined) return named.browser_download_url as string
  }
  const tarballs = assets.filter(asset => typeof asset.name === 'string' && asset.name.endsWith('.tgz'))
  return tarballs.length === 1 ? tarballs[0]!.browser_download_url as string : undefined
}

type PendingUpdateMarker = {
  readonly version: 1
  readonly packageName: string
  readonly targetVersion: string
  readonly backupDirectory: string
  readonly attempts: number
  readonly processId: number
  /** Set while the install is in flight; a crash then must restore the recovery point. */
  readonly promoting?: boolean
}

function isSemver(value: string): boolean { return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) }

/**
 * Compare semver versions used by package releases, including prereleases.
 * @param left - the first version.
 * @param right - the second version.
 * @returns a negative, zero, or positive number when `left` sorts before, equal to, or after `right`.
 */
export function compareVersions(left: string, right: string): number {
  const parseVersion = (value: string): { numbers: readonly number[]; pre: readonly string[] } => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value)
    if (match === null) return { numbers: [0, 0, 0], pre: [] }
    return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4]?.split('.') ?? [] }
  }
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < 3; index += 1) if (a.numbers[index] !== b.numbers[index]) return a.numbers[index]! - b.numbers[index]!
  if (a.pre.length === 0 || b.pre.length === 0) return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const leftPart = a.pre[index]
    const rightPart = b.pre[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart)
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

/**
 * Argv re-invoking the CLI that launched this Host, so an install works whether
 * `dsh` runs from a global bin, a local install, or repository source.
 *
 * Searching `PATH` first would be wrong for the same reason it is wrong for the
 * command line the user typed: the CLI already running this process is the one
 * whose profile rules and bundle reconciliation the install must agree with, and
 * a different `dsh` earlier on `PATH` may be an older build that reconciles
 * differently. Falls back to a `PATH` lookup only when the entry point is not
 * identifiable (an embedded host whose argv[1] is not the CLI).
 * @param entry - the CLI entry point, defaulting to this process's argv[1].
 * @returns the file, arguments, cwd, and whether a shell is required.
 */
export function dshArgv(entry: string | undefined = process.argv[1]): { readonly file: string; readonly args: readonly string[]; readonly cwd: string | undefined; readonly viaShell: boolean } {
  if (entry !== undefined && /[\\/](?:bin\.(?:js|ts)|dsh)$/.test(entry)) {
    // Absolute paths are required: a source launch passes a relative entry,
    // which the child resolves against its OWN cwd.
    const absolute = resolve(entry)
    return { file: process.execPath, args: [...process.execArgv, absolute], cwd: dirname(absolute), viaShell: false }
  }
  // A bare `dsh` is a `.cmd` shim on Windows, which only a shell can start.
  return { file: 'dsh', args: [], cwd: undefined, viaShell: process.platform === 'win32' }
}

/** Whether a spawned token has to cross a Windows `cmd.exe` command line. */
const CMD_METACHARS = /[\s"&|<>^()%!]/

/**
 * Directories appended to a child's `PATH`.
 *
 * A desktop or Finder launch inherits no shell profile, so a package manager
 * the user installed normally is missing and every install dies with ENOENT —
 * while the same command works in their terminal. Appending the directories the
 * toolchain actually installs into is what makes the button work from a
 * double-clicked app.
 * @param platform - the platform whose install locations are added.
 * @param env - the environment the install locations are read from.
 * @param home - the home directory, for the POSIX fallbacks.
 * @returns the directories to append to a child's PATH.
 */
export function toolSearchDirectories(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const directories: string[] = []
  const pnpmHome = (env.PNPM_HOME ?? '').trim()
  if (pnpmHome !== '') directories.push(pnpmHome)
  if (platform === 'win32') {
    const local = (env.LOCALAPPDATA ?? '').trim()
    const roaming = (env.APPDATA ?? '').trim()
    if (local !== '') directories.push(join(local, 'pnpm'))
    if (roaming !== '') directories.push(join(roaming, 'npm'))
  } else {
    directories.push('/opt/homebrew/bin', '/usr/local/bin', join(home, '.local', 'bin'))
  }
  directories.push(dirname(process.execPath))
  return [...new Set(directories.filter(directory => directory.trim() !== ''))]
}

/**
 * Translate the machine's proxy environment into the vocabulary each consumer
 * reads.
 *
 * pnpm ignores `HTTPS_PROXY` completely — it reads npm config, so a proxy only
 * reaches it as `npm_config_https_proxy`. `git`, which pnpm shells out to for
 * any git-hosted dependency, reads only the standard variables and never npm
 * config. A value the caller already set for the consumer in question always
 * wins: this function fills silence rather than overwriting intent.
 * @param env - the machine environment the proxy is read from.
 * @returns the proxy vocabulary each consumer reads.
 */
export function proxyEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const read = (...names: readonly string[]): string | null => {
    for (const name of names) {
      const raw = env[name]
      if (raw !== undefined && raw.trim() !== '') return raw.trim()
    }
    return null
  }
  const output: NodeJS.ProcessEnv = {}
  const https = read('https_proxy', 'HTTPS_PROXY') ?? read('http_proxy', 'HTTP_PROXY')
  const http = read('http_proxy', 'HTTP_PROXY') ?? https
  if (https !== null && read('npm_config_https_proxy') === null) output.npm_config_https_proxy = https
  if (http !== null && read('npm_config_proxy') === null) output.npm_config_proxy = http
  const noProxy = read('no_proxy', 'NO_PROXY')
  if (noProxy !== null && read('npm_config_noproxy') === null) output.npm_config_noproxy = noProxy
  return output
}

/**
 * Run one profile package operation through the Harness's own CLI.
 *
 * `dsh plugin` is the only writer of a profile manifest: it owns the dependency
 * edit *and* the `dsh.profile.bundles` reconciliation, loads each newly mounted
 * bundle's overlay patch, and reports through the one diagnostic log the CLI
 * keeps. A plugin that ran `pnpm` itself and reconciled the bundle list by hand
 * would be a second writer of the same file, and it would silently drift the
 * moment those rules change — which is exactly what the hand-rolled copy did.
 * @param profile - the profile name the operation edits.
 * @param args - pnpm arguments after `plugin`, for example `['add', spec]`.
 * @returns the exit code and the last output line, **unredacted**: a caller that
 * stores or displays it must pass it through `redactCredentialShapes` first.
 */
export async function runDsh(profile: string, args: readonly string[]): Promise<{ readonly code: number; readonly detail: string }> {
  const plugin = ['plugin', '--profile', profile, ...args]
  const argv = dshArgv()
  // Built for every platform (it is pure) so the Windows command line is one
  // exported, testable value rather than a string constructed at a spawn site.
  const shim = windowsShimCommandLine(argv.file, [...argv.args, ...plugin])
  const separator = process.platform === 'win32' ? ';' : ':'
  const path = [...(process.env.PATH ?? '').split(separator).filter(part => part !== ''), ...toolSearchDirectories()]
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...proxyEnvironment(process.env),
    // pnpm v10+ blocks forever on a silent interactive prompt without a TTY;
    // CI mode makes it act or fail instead of asking a question nobody sees.
    CI: 'true',
    PATH: [...new Set(path)].join(separator),
  }
  return new Promise((resolve, reject) => {
    // A `.cmd` shim cannot be started by `spawn` without a shell, and Node
    // rejects `shell: true` combined with an argv array, so the Windows shim
    // path builds one quoted command line for `cmd.exe` instead.
    const child = argv.viaShell && process.platform === 'win32'
      ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', shim.line], { cwd: argv.cwd, env: { ...environment, ...shim.environment }, shell: false, windowsVerbatimArguments: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(argv.file, [...argv.args, ...plugin], { cwd: argv.cwd, env: environment, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let timedOut = false
    const append = (chunk: Buffer | string): void => { output = `${output}${chunk.toString()}`.slice(-8_000) }
    const timer = setTimeout(() => { timedOut = true; child.kill() }, DSH_INSTALL_TIMEOUT_MS)
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      const lastLine = output.trim().split(/\r?\n/u).filter(Boolean).at(-1)
      resolve({
        code: timedOut ? 1 : code ?? 1,
        detail: timedOut
          ? `dsh plugin install timed out after ${DSH_INSTALL_TIMEOUT_MS / 1_000}s`
          : lastLine ?? `dsh plugin exited with code ${code ?? 1}`,
      })
    })
  })
}

/** Quote one argv token for a `cmd.exe` `/c` command line. */
function quoteCmdToken(token: string): string {
  if (!CMD_METACHARS.test(token)) return token
  return `"${token.replace(/"/g, '""')}"`
}

/**
 * The `cmd.exe` command line for a shim launch, and the environment entries that
 * carry the tokens quoting cannot make safe.
 *
 * Quoting alone does not protect a token: `cmd.exe` expands `%NAME%` for every
 * *defined* variable **even inside double quotes**, so the release asset URL — the
 * one token here that can carry arbitrary publisher-chosen text — would arrive
 * as whatever that variable holds. Measured, not assumed:
 * `https://host/a%FCG_PROBE%b.tgz` reaches the child as
 * `https://host/a<FCG_PROBE's value>b.tgz` while `%20` (an undefined variable
 * name) survives untouched, which is exactly why this went unnoticed.
 *
 * Such a token is therefore handed over in the environment and referenced by
 * name: `cmd.exe` substitutes the text once, and never re-parses the result. A
 * token without `%` keeps the plain quoted form, so an ordinary install command
 * line is byte-for-byte what it was before.
 *
 * @param file - the shim to run (`dsh`, or the CLI entry point).
 * @param args - the arguments after it.
 * @returns the verbatim command line and the extra child environment entries.
 */
export function windowsShimCommandLine(file: string, args: readonly string[]): { readonly line: string; readonly environment: Record<string, string> } {
  const environment: Record<string, string> = {}
  const tokens = [file, ...args].map((token, index) => {
    if (!token.includes('%')) return quoteCmdToken(token)
    const name = `FCG_DSH_ARG_${index}`
    environment[name] = token
    return `"%${name}%"`
  })
  return { line: `"${tokens.join(' ')}"`, environment }
}
