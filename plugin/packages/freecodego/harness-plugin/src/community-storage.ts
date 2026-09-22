import fs from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { CommunityCatalogPlugin } from './types.ts'
import { omitRecordKey } from './record-utils.ts'

const NPM_PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i

/**
 * A note that plugins were installed while this Host was running.
 *
 * The process id and its start time are both recorded because an id is reused: a
 * marker written by a dead Host must not be read as "this one has to restart",
 * and the start time is what tells the two apart.
 */
export interface CommunityRestartMarker { readonly processId: number; readonly runtimeStartTime: number; readonly packageNames: readonly string[] }

/**
 * What each community source installed, keyed by source URL.
 *
 * Recorded because a source's own `npm` field is a claim, while this is what the
 * install actually brought in: uninstalling has to remove the packages a source
 * added, and a source that changed what it ships since then would leave the old
 * ones behind.
 */
export interface CommunityInstallationLedger { readonly version: 1; readonly entries: Readonly<Record<string, readonly string[]>> }

// Installation and removal both read the complete ledger before publishing an
// updated copy. Queue them by file so two simultaneous installs cannot each
// publish a snapshot that omits the other's source entry.
const ledgerUpdateChains = new Map<string, Promise<void>>()

/**
 * Read a JSON document, treating every failure as an empty one.
 *
 * An unreadable file is renamed aside rather than deleted, so a file that turned
 * out to be worth keeping is still on disk: this is a cache of what the user
 * installed, and losing it costs a reinstall, not data.
 * @param file - the JSON document to read.
 * @returns Its object contents, or an empty object when it is missing or malformed.
 */
export async function readJsonFile(file: string): Promise<Record<string, any>> {
  let raw: string
  try { raw = await fs.readFile(file, 'utf8') } catch { return {} }
  try { return JSON.parse(raw) as Record<string, any> } catch { await fs.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => undefined); return {} }
}
/**
 * Keep the string entries of a value read from disk.
 * @param value - a parsed JSON value of unknown shape.
 * @returns Its string members, in order; empty for anything that is not an array.
 */
export function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [] }

/**
 * Write a JSON document atomically, readable by its owner only.
 * @param file - the path to replace; its parent is created when missing.
 * @param value - the document to write.
 * @returns Resolves once the replacement is durable.
 */
export async function writeJsonFile(file: string, value: Record<string, any>): Promise<void> {
  // 0600: an installation ledger records what this user installed, not a
  // document other local accounts have any business reading.
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
}
/**
 * Read the restart marker, ignoring one that cannot be acted on.
 *
 * Every field is required for a reason: without a process id and start time the
 * marker cannot be tied to a Host, and without package names there is nothing to
 * tell the user to restart for. A partially written marker is therefore dropped
 * rather than reported as a pending restart.
 * @param file - the marker document to read.
 * @returns The marker, or `undefined` when there is nothing to act on.
 */
export async function readCommunityRestartMarker(file: string): Promise<CommunityRestartMarker | undefined> {
  const value = await readJsonFile(file); const packageNames = stringArray(value.packageNames)
  if (typeof value.processId !== 'number' || !Number.isSafeInteger(value.processId) || value.processId <= 0 || typeof value.runtimeStartTime !== 'number' || !Number.isFinite(value.runtimeStartTime) || packageNames.length === 0) return undefined
  return { processId: value.processId, runtimeStartTime: value.runtimeStartTime, packageNames }
}
/**
 * Where one profile records what its community sources installed.
 * @param directory - the profile directory the ledger belongs to.
 * @returns The absolute path of that profile's ledger.
 */
export function communityInstallationLedgerPath(directory: string): string { return path.join(directory, '.dsh-market', 'freecodego-community-installations.json') }

/**
 * The key one source is recorded under.
 *
 * Trimmed and lower-cased because the same source arrives spelled differently — a
 * user types it, a catalog lists it — and two keys for one source would leave an
 * uninstall removing only the packages it happened to be asked about.
 * @param url - the source URL as given.
 * @returns The canonical key for that source.
 */
export function communitySourceKey(url: string): string { return url.trim().toLowerCase() }
/**
 * Read the ledger, keeping only entries that name real packages.
 *
 * Filtered on the way in rather than on the way out, so a hand-edited entry cannot
 * reach an uninstall command as something that would be passed to the package
 * manager as a spec.
 * @param file - the ledger document to read.
 * @returns The ledger, with empty and non-package entries dropped.
 */
export async function readCommunityInstallationLedger(file: string): Promise<CommunityInstallationLedger> {
  const value = await readJsonFile(file); const entries = value.entries !== null && typeof value.entries === 'object' ? value.entries as Record<string, unknown> : {}
  const valid = Object.fromEntries(Object.entries(entries).map(([source, names]) => [source, stringArray(names).filter(name => NPM_PACKAGE_RE.test(name))] as const).filter(([, names]) => names.length > 0))
  return { version: 1, entries: valid }
}
/**
 * Record what one source installed, replacing any earlier record for it.
 *
 * A call with no usable package name writes nothing at all: an install that named
 * nothing must not empty the record of what is on disk, or the packages would
 * become unremovable.
 * @param file - the ledger document to update.
 * @param url - the source the packages came from.
 * @param packageNames - the packages that source installed.
 * @returns Resolves once the ledger is durable.
 */
export async function writeCommunityInstallationLedger(file: string, url: string, packageNames: readonly string[]): Promise<void> {
  const names = [...new Set(packageNames.filter(name => NPM_PACKAGE_RE.test(name)))]
  if (names.length === 0) return
  await updateCommunityInstallationLedger(file, ledger => ({ ...ledger.entries, [communitySourceKey(url)]: names }))
}
/**
 * Forget what one source installed, after it has been uninstalled.
 * @param file - the ledger document to update.
 * @param url - the source being removed.
 * @returns Resolves once the ledger is durable; an absent entry is not an error.
 */
export async function removeCommunityInstallationLedgerEntry(file: string, url: string): Promise<void> {
  const key = communitySourceKey(url)
  await updateCommunityInstallationLedger(file, ledger => ledger.entries[key] === undefined ? ledger.entries : omitRecordKey(ledger.entries, key))
}

/** Serialize one ledger's read-modify-write updates without coupling other profiles. */
function updateCommunityInstallationLedger(
  file: string,
  update: (ledger: CommunityInstallationLedger) => Readonly<Record<string, readonly string[]>>,
): Promise<void> {
  const previous = ledgerUpdateChains.get(file) ?? Promise.resolve()
  const write = previous.catch(() => undefined).then(async () => {
    const ledger = await readCommunityInstallationLedger(file)
    // `writeJsonFile` creates the parent itself, so no mkdir is needed here.
    await writeJsonFile(file, { version: 1, entries: update(ledger) })
  })
  const settled = write.finally(() => {
    if (ledgerUpdateChains.get(file) === settled) ledgerUpdateChains.delete(file)
  })
  ledgerUpdateChains.set(file, settled)
  return settled
}
/**
 * The packages one source is still responsible for in this profile.
 *
 * The ledger is the answer and the source's own `npm` field is a fallback, so a
 * source that predates the ledger can still be uninstalled. Either way a name is
 * only reported when the profile's dependencies actually carry it: a package the
 * user removed by hand must not be reported as present, or the uninstall would
 * claim to have taken something away that was already gone.
 * @param entry - the catalog entry being uninstalled.
 * @param dependencies - the profile's declared dependencies.
 * @param ledger - the recorded installations to prefer over the entry's claim.
 * @returns The package names to remove, without duplicates.
 */
export function installedCommunityPackageNames(entry: Pick<CommunityCatalogPlugin, 'name' | 'npm' | 'url'>, dependencies: Record<string, unknown>, ledger: CommunityInstallationLedger): string[] {
  const recorded = ledger.entries[communitySourceKey(entry.url)] ?? []
  const npmFallback = typeof entry.npm === 'string' && NPM_PACKAGE_RE.test(entry.npm) ? [entry.npm] : []
  return [...new Set([...recorded, ...npmFallback].filter(name => dependencies[name] !== undefined))]
}
