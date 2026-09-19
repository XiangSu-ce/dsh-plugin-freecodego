import fs from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { CommunityCatalogPlugin } from './types.ts'
import { omitRecordKey } from './record-utils.ts'

const NPM_PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i

export interface CommunityRestartMarker { readonly processId: number; readonly runtimeStartTime: number; readonly packageNames: readonly string[] }
export interface CommunityInstallationLedger { readonly version: 1; readonly entries: Readonly<Record<string, readonly string[]>> }

// Installation and removal both read the complete ledger before publishing an
// updated copy. Queue them by file so two simultaneous installs cannot each
// publish a snapshot that omits the other's source entry.
const ledgerUpdateChains = new Map<string, Promise<void>>()

export async function readJsonFile(file: string): Promise<Record<string, any>> {
  let raw: string
  try { raw = await fs.readFile(file, 'utf8') } catch { return {} }
  try { return JSON.parse(raw) as Record<string, any> } catch { await fs.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => undefined); return {} }
}
export function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [] }
export async function writeJsonFile(file: string, value: Record<string, any>): Promise<void> {
  // 0600: an installation ledger records what this user installed, not a
  // document other local accounts have any business reading.
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
}
export async function readCommunityRestartMarker(file: string): Promise<CommunityRestartMarker | undefined> {
  const value = await readJsonFile(file); const packageNames = stringArray(value.packageNames)
  if (typeof value.processId !== 'number' || !Number.isSafeInteger(value.processId) || value.processId <= 0 || typeof value.runtimeStartTime !== 'number' || !Number.isFinite(value.runtimeStartTime) || packageNames.length === 0) return undefined
  return { processId: value.processId, runtimeStartTime: value.runtimeStartTime, packageNames }
}
export function communityInstallationLedgerPath(directory: string): string { return path.join(directory, '.dsh-market', 'freecodego-community-installations.json') }
export function communitySourceKey(url: string): string { return url.trim().toLowerCase() }
export async function readCommunityInstallationLedger(file: string): Promise<CommunityInstallationLedger> {
  const value = await readJsonFile(file); const entries = value.entries !== null && typeof value.entries === 'object' ? value.entries as Record<string, unknown> : {}
  const valid = Object.fromEntries(Object.entries(entries).map(([source, names]) => [source, stringArray(names).filter(name => NPM_PACKAGE_RE.test(name))] as const).filter(([, names]) => names.length > 0))
  return { version: 1, entries: valid }
}
export async function writeCommunityInstallationLedger(file: string, url: string, packageNames: readonly string[]): Promise<void> {
  const names = [...new Set(packageNames.filter(name => NPM_PACKAGE_RE.test(name)))]
  if (names.length === 0) return
  await updateCommunityInstallationLedger(file, ledger => ({ ...ledger.entries, [communitySourceKey(url)]: names }))
}
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
export function installedCommunityPackageNames(entry: Pick<CommunityCatalogPlugin, 'name' | 'npm' | 'url'>, dependencies: Record<string, unknown>, ledger: CommunityInstallationLedger): string[] {
  const recorded = ledger.entries[communitySourceKey(entry.url)] ?? []
  const npmFallback = typeof entry.npm === 'string' && NPM_PACKAGE_RE.test(entry.npm) ? [entry.npm] : []
  return [...new Set([...recorded, ...npmFallback].filter(name => dependencies[name] !== undefined))]
}
