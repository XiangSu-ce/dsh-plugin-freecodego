/**
 * Community plugin marketplace and capability-marketplace remotes for the
 * FreeCodeGo Harness plugin: the public plugin catalog, repository artwork
 * resolution, profile-local plugin installation, and the MCP.so / skills.sh
 * directory browsing behind the capability marketplace.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/community-remotes
 */

import type { Context } from '@deepseek-ai/cordis'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { redactCredentialShapes } from './secret-scan.ts'
import type { FreeCodeGoCapabilityRegistry } from './capabilities.ts'
import type { FreeCodeGoManagedCatalogs } from './managed-catalogs.ts'
import { assertExternalEngineeringAssetSafe } from './engineering.ts'
import { record } from './media-generation.ts'
import { communityInstallationLedgerPath, communitySourceKey, installedCommunityPackageNames, readCommunityInstallationLedger, readCommunityRestartMarker, readJsonFile, removeCommunityInstallationLedgerEntry, stringArray, writeCommunityInstallationLedger, writeJsonFile } from './community-storage.ts'
import { commandAvailable, communityInstallTarget, fetchCommunityCatalog, importGithubSkill, readCommunityCatalogCache, readCommunityIconCache, resolveCommunityRepositoryIcon, runPnpm } from './community-catalog-utils.ts'
import { fetchMarketplaceJson, marketplaceMcpDefinition, marketplaceMcpSummary, marketplaceNumber, marketplacePathSegment, marketplaceSkillSummary, marketplaceText, mcpDefinitionRequiresConfiguration, normalizeMarketplaceRequest, parseMarketplaceId } from './marketplace-utils.ts'
import type { CommunityCatalogPayload, CommunityCatalogPlugin, FreeCodeGoCapabilityMarketplaceItem, FreeCodeGoCapabilityMarketplacePage, FreeCodeGoCapabilityMarketplaceRequest, FreeCodeGoCapabilitySettings, FreeCodeGoCapabilitySnapshot } from './types.ts'

const COMMUNITY_REGISTRY_URL = 'https://awesome-dsh-plugin.com/plugins.json'
// The canonical catalog is GitHub Pages-backed. Keep npm CDN copies as
// network fallbacks because they are significantly more reliable on some
// mainland networks and contain the same published catalog payload.
const COMMUNITY_REGISTRY_FALLBACK_URLS = [
  'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/plugins.json',
  'https://unpkg.com/dsh-plugin-catalog/plugins.json',
] as const
const COMMUNITY_ICON_CACHE_TTL_MS = 7 * 24 * 60 * 60_000
const COMMUNITY_ICON_REQUEST_LIMIT = 24

/**
 * How many Skill/MCP assets one package may carry before the install scan
 * refuses it.
 *
 * The same number as `walkBounded`'s directory bound, so the two ceilings a
 * package can reach agree: a package that fits inside the walk has room for one
 * asset per directory. It is far past any real bundle, because the point of the
 * number is to bound the work a hostile package can hand the scan, not to
 * describe how many skills a bundle ought to have.
 */
const COMMUNITY_ASSET_SCAN_LIMIT = 512

/**
 * How many directories one package may reach before the install scan refuses it.
 *
 * The walk caps the number of `readdir` calls a hostile package can hand the
 * scan. Reaching the cap is not a partial answer this module is willing to
 * report as a clean one: a package can put an asset in each of five hundred
 * directories and the hostile one in the directory past the cap, and a walk that
 * stopped without saying so would let the package choose where screening ended —
 * the same defect the asset budget had, one level up.
 */
const COMMUNITY_WALK_DIRECTORY_LIMIT = 512
const COMMUNITY_ICON_RESOLUTION_CONCURRENCY = 4

const MCP_SO_SERVERS_URL = 'https://mcp.so/api/mcp-servers'
const MCP_SO_CATEGORIES_URL = 'https://mcp.so/api/mcp-categories'
const FREECODEGO_FEATURED_MCP_CATEGORY = 'freecodego-featured'
const FREECODEGO_FEATURED_MCP_SLUGS = [
  'context7-mcp', 'github-mcp-server', 'filesystem', 'memory',
  'mcp-server-mas-sequential-thinking', 'playwright-mcp', 'brave-search',
  'postgres', 'sentry', 'linear', 'notion', 'google-maps',
] as const
const SKILLS_SH_SEARCH_URL = 'https://skills.sh/api/search'
const MARKETPLACE_CACHE_TTL_MS = 10 * 60_000
/** How long one capability-marketplace cache file may stay on disk before a sweep removes it. */
const MARKETPLACE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000
/** How often a sweep may run; see {@link pruneMarketplaceCache}. */
const MARKETPLACE_CACHE_PRUNE_INTERVAL_MS = 6 * 60 * 60_000
/** Filename prefix of every capability-marketplace cache entry. */
const MARKETPLACE_CACHE_PREFIX = 'capability-marketplace-'
const SKILL_MARKETPLACE_CATEGORIES = [
  ['design-ui', '设计与 UI'], ['agent-workflows', 'Agent 工作流'], ['testing-quality', '测试与质量'],
  ['marketing-growth', '营销与增长'], ['data-databases', '数据与数据库'], ['security', '安全'],
  ['cloud-devops', '云与 DevOps'], ['creative-media', '创意与媒体'], ['document-processing', '文档处理'],
  ['development', '开发与编程'], ['productivity-tools', '效率工具'], ['other', '其他'],
] as const

/**
 * Mutable per-instance coordination state for the community remotes. The
 * plugin instance owns this object and hands it out through `communityHost`;
 * the extracted implementations mutate it in place so the install mutex and
 * the in-flight catalog/refresh caches keep their original semantics.
 */
export interface CommunityRemotesState {
  /** Serializes community plugin install/uninstall operations. */
  communityMutationTask: Promise<unknown> | undefined
  /** In-flight community catalog load, deduplicating concurrent reads. */
  communityCatalogPromise: Promise<CommunityCatalogPayload> | undefined
  /** In-flight background community catalog refresh. */
  communityCatalogRefreshPromise: Promise<void> | undefined
  /** Background capability-marketplace JSON refreshes, keyed by cache entry. */
  readonly marketplaceRefreshPromises: Map<string, Promise<void>>
  /** Serializes icon-cache read-modify-write cycles. */
  communityIconCacheTask: Promise<unknown> | undefined
  /** When the capability-marketplace cache was last swept, in epoch milliseconds. */
  marketplaceCachePrunedAt: number
}

/**
 * Narrow view of the plugin surface required by the community remotes. The
 * plugin satisfies it through its `communityHost` accessor; members that map
 * to plugin methods delegate back to the live instance so instance-level
 * overrides (tests, future remotes) keep working.
 */
export interface CommunityRemotesHost {
  readonly ctx: Context
  readonly capabilities: FreeCodeGoCapabilityRegistry
  readonly catalogs: FreeCodeGoManagedCatalogs
  readonly state: CommunityRemotesState
  readonly communityCatalog: () => Promise<CommunityCatalogPayload>
  readonly communityProfileDirectory: () => string
  readonly communitySkillDirectory: () => string
  readonly communityRuntimeStartTime: () => number
}

/** Read one bounded page from the public MCP.so or skills.sh directory. */
export async function capabilityMarketplace(host: CommunityRemotesHost, input: FreeCodeGoCapabilityMarketplaceRequest): Promise<FreeCodeGoCapabilityMarketplacePage> {
  const request = normalizeMarketplaceRequest(input)
  const configuration = host.capabilities.configuration()
  if (request.kind === 'mcp') {
    if (request.category === FREECODEGO_FEATURED_MCP_CATEGORY && request.query === '') {
      const items = await featuredMcpMarketplace(host, configuration)
      return {
        kind: 'mcp', total: items.length, offset: 0, limit: items.length,
        categories: [{ id: FREECODEGO_FEATURED_MCP_CATEGORY, label: 'FreeCodeGo 精选' }], items,
      }
    }
    const url = new URL(MCP_SO_SERVERS_URL)
    if (request.query !== '') url.searchParams.set('q', request.query)
    if (request.category !== '') url.searchParams.set('category', request.category)
    url.searchParams.set('limit', String(request.limit))
    url.searchParams.set('offset', String(request.offset))
    const response = record(record(await marketplaceJson(host, url)).data)
    const servers = Array.isArray(response.servers) ? response.servers : []
    const items = servers.flatMap(value => marketplaceMcpSummary(value, configuration))
      .sort((left, right) => right.popularity - left.popularity)
    const categories = await mcpMarketplaceCategories(host)
    return {
      kind: 'mcp', total: marketplaceNumber(response.total), limit: marketplaceNumber(response.limit) || request.limit,
      offset: marketplaceNumber(response.offset), ...(request.query === '' ? {} : { query: request.query }), categories, items,
    }
  }
  const search = request.query || request.category.replaceAll('-', ' ') || 'ai'
  const url = new URL(SKILLS_SH_SEARCH_URL)
  url.searchParams.set('q', search)
  // Ask for one wide window and slice locally: applying the upstream offset
  // AND a local slice twice made page 2 empty under the paged contract, and
  // under the unpaged contract the local slice keeps the pagination correct.
  // The upstream page length bounds `total` only when it returns an unpaged
  // first window.
  const UPSTREAM_WINDOW = 120
  url.searchParams.set('limit', String(UPSTREAM_WINDOW))
  url.searchParams.delete('offset')
  const response = record(await marketplaceJson(host, url))
  const skills = Array.isArray(response.skills) ? response.skills : []
  const total = marketplaceNumber(response.count) || skills.length
  const items = skills
    .flatMap(value => marketplaceSkillSummary(value, host.communitySkillDirectory()))
    .sort((left, right) => right.popularity - left.popularity)
    .slice(request.offset, request.offset + request.limit)
  return {
    kind: 'skill', total, limit: request.limit, offset: request.offset,
    ...(request.query === '' ? {} : { query: request.query }),
    categories: SKILL_MARKETPLACE_CATEGORIES.map(([id, label]) => ({ id, label })), items,
  }
}

/** Add a public MCP.so entry when its published configuration can be represented by the shared runtime. */
export async function mcpPresetInstall(host: CommunityRemotesHost, id: string): Promise<FreeCodeGoCapabilitySnapshot> {
  const slug = parseMarketplaceId(id, 'mcp')
  const detail = record(record(await marketplaceJson(host, new URL(`${MCP_SO_SERVERS_URL}/${encodeURIComponent(slug)}`))).data)
  if (typeof detail.config === 'string') assertExternalEngineeringAssetSafe(`mcp:${slug}:config`, detail.config)
  const definition = marketplaceMcpDefinition(slug, detail)
  if (definition === undefined) throw new Error('该 MCP 条目未提供可自动导入的 HTTP 地址或 stdio 启动命令，请在详情中参考其安装说明后手动添加')
  if (mcpDefinitionRequiresConfiguration(definition)) throw new Error('该 MCP 条目需要先填写环境变量或请求头，不能一键安装；请使用手动添加完成配置')
  assertExternalEngineeringAssetSafe(`mcp:${slug}`, JSON.stringify(definition))
  const current = host.capabilities.configuration()
  if (!current.mcpServers.some(server => server.serverName === definition.serverName)) await host.capabilities.saveMcpServer(definition)
  return host.capabilities.setEnabled({ mcpEnabled: true })
}

/** Import one skills.sh entry from its verified GitHub source repository. */
export async function skillPresetInstall(host: CommunityRemotesHost, id: string): Promise<FreeCodeGoCapabilitySnapshot> {
  const identity = parseMarketplaceId(id, 'skill')
  const parts = identity.split('/').filter(Boolean)
  if (parts.length < 3 || parts.some(part => !/^[A-Za-z0-9_.-]{1,128}$/.test(part))) throw new Error('invalid skills.sh identifier')
  const source = parts.slice(0, -1).join('/')
  const skillName = parts.at(-1)!
  const root = host.communitySkillDirectory()
  const directory = path.join(root, marketplacePathSegment(identity))
  await importGithubSkill({ source, skillName, destination: directory })
  return host.capabilities.enableManagedSkillRoot('freecodego-community', root)
}

/** Public, credential-free community catalog used by the embedded settings page. */
export async function communityCatalog(host: CommunityRemotesHost): Promise<CommunityCatalogPayload> {
  if (host.state.communityCatalogPromise !== undefined) return host.state.communityCatalogPromise
  const operation = loadCommunityCatalog(host)
  host.state.communityCatalogPromise = operation
  try { return await operation } finally {
    if (host.state.communityCatalogPromise === operation) host.state.communityCatalogPromise = undefined
  }
}

/** Resolve only verified repository artwork; never synthesize a plugin identity. */
export async function communityCatalogIcons(host: CommunityRemotesHost, urls: readonly string[]): Promise<Record<string, string>> {
  // Serialize icon batches: concurrent read-modify-write on the shared cache
  // file lets the later writer drop entries resolved by the earlier one.
  const previous = host.state.communityIconCacheTask
  const task = (async (): Promise<Record<string, string>> => {
    await previous?.catch(() => undefined)
    return resolveCommunityIcons(host, urls)
  })()
  host.state.communityIconCacheTask = task.catch(() => undefined)
  return task
}

async function resolveCommunityIcons(host: CommunityRemotesHost, urls: readonly string[]): Promise<Record<string, string>> {
  const catalog = await host.communityCatalog()
  const allowed = new Map(catalog.plugins.map(plugin => [communitySourceKey(plugin.url), plugin]))
  const requested = Array.isArray(urls) ? urls : []
  const plugins = [...new Map(requested
    .filter((url): url is string => typeof url === 'string')
    .slice(0, COMMUNITY_ICON_REQUEST_LIMIT)
    .map(url => allowed.get(communitySourceKey(url)))
    .filter((plugin): plugin is CommunityCatalogPlugin => plugin !== undefined)
    .map(plugin => [communitySourceKey(plugin.url), plugin]))
    .values()]
  if (plugins.length === 0) return {}

  const now = Date.now()
  const cachePath = host.catalogs.catalogCachePath('community-plugin-icons.json')
  const cache = await readCommunityIconCache(cachePath)
  const entries = { ...cache.entries }
  const unresolved: CommunityCatalogPlugin[] = []
  const resolved: Record<string, string> = {}
  for (const plugin of plugins) {
    if (plugin.iconUrl !== undefined) {
      resolved[plugin.url] = plugin.iconUrl
      continue
    }
    const screenshot = plugin.screenshots?.[0]
    if (screenshot !== undefined) {
      resolved[plugin.url] = screenshot
      continue
    }
    const saved = entries[communitySourceKey(plugin.url)]
    if (saved !== undefined && saved.expiresAt > now) {
      if (saved.iconUrl !== null) resolved[plugin.url] = saved.iconUrl
      continue
    }
    unresolved.push(plugin)
  }

  for (let start = 0; start < unresolved.length; start += COMMUNITY_ICON_RESOLUTION_CONCURRENCY) {
    const batch = unresolved.slice(start, start + COMMUNITY_ICON_RESOLUTION_CONCURRENCY)
    const discovered = await Promise.all(batch.map(async plugin => ({ plugin, iconUrl: await resolveCommunityRepositoryIcon(plugin.url) })))
    for (const { plugin, iconUrl } of discovered) {
      // `undefined` is a transient lookup failure. Do not poison the cache.
      if (iconUrl === undefined) continue
      entries[communitySourceKey(plugin.url)] = { expiresAt: now + COMMUNITY_ICON_CACHE_TTL_MS, iconUrl }
      if (iconUrl !== null) resolved[plugin.url] = iconUrl
    }
  }
  if (unresolved.length > 0) {
    // A cache write failure (locked file, full disk) must not fail the whole
    // request: the resolved icons are still returned, just not cached.
    await fs.mkdir(path.dirname(cachePath), { recursive: true })
      .then(() => writeJsonFile(cachePath, { version: 2, entries }))
      .catch(() => undefined)
  }
  return resolved
}

export async function communityEnvironment(host: CommunityRemotesHost): Promise<{ readonly ready: boolean; readonly platform: string; readonly node: string; readonly profile: string }> {
  const ready = await commandAvailable('pnpm')
  return { ready, platform: `${process.platform}-${process.arch}`, node: process.version, profile: host.communityProfileDirectory() }
}

export async function communityInstalled(host: CommunityRemotesHost): Promise<{ readonly installed: Record<string, string>; readonly activation: Record<string, { readonly state: string }>; readonly sources: Record<string, readonly string[]>; readonly restartRequired: boolean }> {
  const directory = host.communityProfileDirectory()
  const manifest = await readJsonFile(path.join(directory, 'package.json'))
  const dependencies = record(manifest.dependencies)
  const bundles = new Set(stringArray(record(record(manifest.dsh).profile).bundles))
  const markerPath = path.join(directory, '.dsh-market', 'restart-pending.json')
  const marker = await readCommunityRestartMarker(markerPath)
  const runtimeStartTime = host.communityRuntimeStartTime()
  // A marker created by a previous process proves that the profile has now
  // crossed a real Harness restart boundary. Clear it and never infer a
  // pending restart merely from the durable bundle list.
  if (marker !== undefined && (marker.processId !== process.pid || marker.runtimeStartTime !== runtimeStartTime)) {
    await fs.rm(markerPath, { force: true }).catch(() => undefined)
  }
  const pending = marker?.processId === process.pid && marker.runtimeStartTime === runtimeStartTime ? new Set(marker.packageNames) : new Set<string>()
  const activation: Record<string, { readonly state: string }> = {}
  for (const name of Object.keys(dependencies)) activation[name] = { state: pending.has(name) ? 'restart' : bundles.has(name) ? 'live' : 'installed' }
  const installed = Object.fromEntries(Object.entries(dependencies).map(([name, value]) => [name, String(value)]))
  const ledger = await readCommunityInstallationLedger(communityInstallationLedgerPath(directory))
  const sources = Object.fromEntries(Object.entries(ledger.entries)
    .map(([source, names]) => [source, names.filter(name => installed[name] !== undefined)] as const)
    .filter(([, names]) => names.length > 0))
  return { installed, activation, sources, restartRequired: pending.size > 0 }
}

export async function communityInstall(host: CommunityRemotesHost, url: string): Promise<{ readonly ok: true; readonly packageNames: readonly string[]; readonly restartRequired: true }> {
  if (host.state.communityMutationTask !== undefined) throw new Error('another community plugin operation is already running')
  const task = installCommunityPlugin(host, url)
  host.state.communityMutationTask = task
  try { return await task } finally { host.state.communityMutationTask = undefined }
}

/** Remove an installed community plugin from the running profile and its next boot. */
export async function communityUninstall(host: CommunityRemotesHost, url: string): Promise<{ readonly ok: true; readonly packageNames: readonly string[]; readonly restartRequired: true }> {
  if (host.state.communityMutationTask !== undefined) throw new Error('another community plugin operation is already running')
  const task = uninstallCommunityPlugin(host, url)
  host.state.communityMutationTask = task
  try { return await task } finally { host.state.communityMutationTask = undefined }
}

async function loadCommunityCatalog(host: CommunityRemotesHost): Promise<CommunityCatalogPayload> {
  const cachePath = host.catalogs.catalogCachePath('community-plugin-catalog.json')
  const cached = await readCommunityCatalogCache(cachePath)
  if (cached !== undefined) {
    refreshCommunityCatalogInBackground(host, cachePath)
    return cached.catalog
  }
  return refreshCommunityCatalog(cachePath)
}

function refreshCommunityCatalogInBackground(host: CommunityRemotesHost, cachePath: string): void {
  if (host.state.communityCatalogRefreshPromise !== undefined) return
  // Tracked, not merely detached: the refresh ends in a write under the plugin's
  // state directory, so an unload has to be able to wait for it. The whole
  // operation is tracked because a drain that only saw the write would still
  // miss one that starts after the drain snapshot.
  const operation = host.catalogs.pendingWrites
    .run(() => refreshCommunityCatalog(cachePath))
    .then(() => undefined, () => undefined)
  host.state.communityCatalogRefreshPromise = operation
  void operation.finally(() => {
    if (host.state.communityCatalogRefreshPromise === operation) host.state.communityCatalogRefreshPromise = undefined
  })
}

async function refreshCommunityCatalog(cachePath: string): Promise<CommunityCatalogPayload> {
  let lastError: unknown
  for (const url of [COMMUNITY_REGISTRY_URL, ...COMMUNITY_REGISTRY_FALLBACK_URLS]) {
    try {
      const catalog = await fetchCommunityCatalog(url)
      await fs.mkdir(path.dirname(cachePath), { recursive: true })
      await writeJsonFile(cachePath, { version: 1, savedAt: Date.now(), catalog })
      return catalog
    } catch (error) {
      lastError = error
    }
  }
  // Masked: the last failure is usually our own message about the HTTP status,
  // but a body that failed to parse contributes Node's parse error, which quotes
  // the first ten characters of that body back. That prefix cannot carry a
  // prefixed credential; the masking is for the shapes short enough to fit.
  const detail = lastError instanceof Error && lastError.message !== '' ? `：${redactCredentialShapes(lastError.message)}` : ''
  throw new Error(`插件市场服务暂时不可用，请检查网络后重试${detail}`)
}

async function installCommunityPlugin(host: CommunityRemotesHost, url: string): Promise<{ readonly ok: true; readonly packageNames: readonly string[]; readonly restartRequired: true }> {
  const catalog = await host.communityCatalog()
  const entry = catalog.plugins.find(item => item.url.toLowerCase() === url.trim().toLowerCase())
  if (entry === undefined) throw new Error('plugin is not in the community catalog')
  const target = communityInstallTarget(entry)
  if (target === undefined) throw new Error('community plugin has no supported npm or GitHub install target')
  const directory = host.communityProfileDirectory()
  const before = await readJsonFile(path.join(directory, 'package.json'))
  const beforeDeps = new Set(Object.keys(record(before.dependencies)))
  const result = await runPnpm(directory, ['add', target])
  if (result.code !== 0) throw new Error(redactCredentialShapes(result.stderr.trim().slice(-2000)) || `pnpm exited with code ${result.code}`)
  const after = await readJsonFile(path.join(directory, 'package.json'))
  const dependencies = record(after.dependencies)
  const added = Object.keys(dependencies).filter(name => !beforeDeps.has(name))
  // A reinstall whose dependencies already exist adds nothing; fall back to
  // the catalog's npm name only when the catalog itself declares one, so a
  // display name can never be used as a package name here.
  const packageNames = added.length > 0 ? added : (typeof entry.npm === 'string' && dependencies[entry.npm] !== undefined ? [entry.npm] : [])
  // An empty package list means nothing new to activate (dependencies were
  // already present); say so instead of a bare restartRequired success that
  // would leave the plugin stuck at "installed" without a live bundle.
  // Re-install = update: the freshly downloaded package must pass the same
  // external-asset scan as its first install, since upstream content changed
  // under a known name. This runs *before* the bundle list and the
  // restart-pending marker are written — otherwise a hostile file threw after
  // activation state was already on disk, and the next start activated it.
  await rescanUpdatedCommunityAssets(directory, packageNames)
  const bundles = [...stringArray(record(record(after.dsh).profile).bundles)]
  for (const name of packageNames) {
    const installed = await readJsonFile(path.join(directory, 'node_modules', name, 'package.json'))
    if (record(installed.dsh).bundle !== undefined && !bundles.includes(name)) bundles.push(name)
  }
  after.dsh = { ...record(after.dsh), profile: { ...record(record(after.dsh).profile), bundles } }
  await writeJsonFile(path.join(directory, 'package.json'), after)
  if (packageNames.length > 0) {
    await writeCommunityInstallationLedger(communityInstallationLedgerPath(directory), entry.url, packageNames)
    const markerPath = path.join(directory, '.dsh-market', 'restart-pending.json')
    await fs.mkdir(path.dirname(markerPath), { recursive: true })
    await writeJsonFile(markerPath, { version: 1, processId: process.pid, runtimeStartTime: host.communityRuntimeStartTime(), packageNames })
  }
  return { ok: true, packageNames, restartRequired: true as const }
}

/** Re-scan installed Skill/MCP assets of updated community packages (best-effort:
 * one unreadable file skips to the next; a hostile file throws and blocks activation). */
async function rescanUpdatedCommunityAssets(directory: string, packageNames: readonly string[]): Promise<void> {
  for (const name of packageNames) {
    const root = path.join(directory, 'node_modules', name)
    let discovered = 0
    let walk: { readonly directories: import('node:fs').Dirent[][]; readonly truncated: boolean }
    try {
      // Bounded walk: package roots only, three levels deep, matching how
      // Skill/MCP assets can nest inside a distributed bundle.
      walk = await walkBounded(root, 3)
    } catch { continue }
    // A capped walk is a refusal, not a partial scan: the directories past the
    // cap were never read, and the package being screened is the one that chose
    // what to put there. Screening everything or activating nothing.
    if (walk.truncated) {
      throw new Error(`community package ${name} nests more directories than the safety scan walks (${String(COMMUNITY_WALK_DIRECTORY_LIMIT)}); refusing to activate what it could not screen`)
    }
    for (const entries of walk.directories) {
      for (const item of entries) {
        if (!item.isFile()) continue
        if (item.name !== 'SKILL.md' && item.name !== 'skill.md' && !item.name.endsWith('.mcp.json')) continue
        discovered += 1
        // Past the budget the package is refused rather than left partly
        // screened. A silent `return` here let the package being screened choose
        // where screening stopped: thirty-three decoy assets ahead of a hostile
        // one meant it was never read, on install and on every later update, and
        // this scan is the gate that is supposed to block activation. An install
        // that cannot be certified clean must not be activated, and refusing is
        // the direction whose mistake a person can see.
        if (discovered > COMMUNITY_ASSET_SCAN_LIMIT) {
          throw new Error(`community package ${name} ships more Skill/MCP assets than the safety scan covers (${String(COMMUNITY_ASSET_SCAN_LIMIT)}); refusing to activate what it could not screen`)
        }
        try {
          const content = await fs.readFile(path.join(item.parentPath ?? item.path ?? root, item.name), 'utf8')
          assertExternalEngineeringAssetSafe(`community-update:${name}:${item.name}`, content, item.name === 'SKILL.md')
        } catch (error) {
          if (error instanceof Error && (error.message.includes('failed the safety scan') || error.message.includes('rejected'))) throw error
          // Unreadable files are skipped; safety rejections propagate.
        }
      }
    }
  }
}

/**
 * Every directory's entries under `root`, breadth-first, capped at
 * `COMMUNITY_WALK_DIRECTORY_LIMIT` directories and `maxDepth` levels.
 *
 * `truncated` reports that the cap was reached with directories still queued, so
 * the caller can refuse the package rather than treat an unfinished walk as a
 * clean one. The cap is on directories rather than on files because each entry
 * list is one `readdir` — it bounds the syscalls a package can demand, which is
 * the bound that matters against a package that ships thousands of them.
 * @param root - the installed package directory to walk.
 * @param maxDepth - how far below the root to descend.
 */
async function walkBounded(root: string, maxDepth: number): Promise<{ readonly directories: import('node:fs').Dirent[][]; readonly truncated: boolean }> {
  const collected: import('node:fs').Dirent[][] = []
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }]
  while (queue.length > 0) {
    if (collected.length >= COMMUNITY_WALK_DIRECTORY_LIMIT) return { directories: collected, truncated: true }
    const current = queue.shift()!
    let entries: import('node:fs').Dirent[]
    try { entries = await fs.readdir(current.directory, { withFileTypes: true }) } catch { continue }
    collected.push(entries)
    if (current.depth >= maxDepth) continue
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
        queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 })
      }
    }
  }
  return { directories: collected, truncated: false }
}

async function uninstallCommunityPlugin(host: CommunityRemotesHost, url: string): Promise<{ readonly ok: true; readonly packageNames: readonly string[]; readonly restartRequired: true }> {
  const catalog = await host.communityCatalog()
  const entry = catalog.plugins.find(item => item.url.toLowerCase() === url.trim().toLowerCase())
  if (entry === undefined) throw new Error('plugin is not in the community catalog')
  const directory = host.communityProfileDirectory()
  const before = await readJsonFile(path.join(directory, 'package.json'))
  const dependencies = record(before.dependencies)
  const ledgerPath = communityInstallationLedgerPath(directory)
  const ledger = await readCommunityInstallationLedger(ledgerPath)
  const packageNames = installedCommunityPackageNames(entry, dependencies, ledger)
  if (packageNames.length === 0) throw new Error('community plugin is not installed in this profile')
  // Remove first, disable after: disabling before the removal would leave the
  // loader entries disabled in the profile when pnpm itself fails.
  const result = await runPnpm(directory, ['remove', ...packageNames])
  if (result.code !== 0) throw new Error(redactCredentialShapes(result.stderr.trim().slice(-2000)) || `pnpm exited with code ${result.code}`)
  await disableCommunityEntries(host, packageNames)
  const after = await readJsonFile(path.join(directory, 'package.json'))
  const bundles = stringArray(record(record(after.dsh).profile).bundles).filter(name => !packageNames.includes(name))
  after.dsh = { ...record(after.dsh), profile: { ...record(record(after.dsh).profile), bundles } }
  await writeJsonFile(path.join(directory, 'package.json'), after)
  await removeCommunityInstallationLedgerEntry(ledgerPath, entry.url)
  const markerPath = path.join(directory, '.dsh-market', 'restart-pending.json')
  await fs.mkdir(path.dirname(markerPath), { recursive: true })
  await writeJsonFile(markerPath, { version: 1, processId: process.pid, runtimeStartTime: host.communityRuntimeStartTime(), packageNames })
  return { ok: true, packageNames, restartRequired: true }
}

async function disableCommunityEntries(host: CommunityRemotesHost, packageNames: readonly string[]): Promise<void> {
  const loader = host.ctx.get('loader') as {
    entries(): Iterable<{ readonly options: { readonly name: string }; readonly disabled: boolean; update(options: { readonly disabled: boolean }): Promise<void> }>
  } | undefined
  if (loader === undefined) return
  const installed = new Set(packageNames)
  for (const entry of loader.entries()) {
    if (!installed.has(entry.options.name) || entry.disabled) continue
    await entry.update({ disabled: true })
  }
}

async function marketplaceJson(host: CommunityRemotesHost, url: URL): Promise<unknown> {
  const key = createHash('sha1').update(url.toString()).digest('hex')
  const cachePath = host.catalogs.catalogCachePath(`${MARKETPLACE_CACHE_PREFIX}${key}.json`)
  const cached = record(await readJsonFile(cachePath))
  const hasCachedPayload = cached.version === 1 && typeof cached.savedAt === 'number' && Object.hasOwn(cached, 'payload')
  if (hasCachedPayload) {
    if (Date.now() - Number(cached.savedAt) >= MARKETPLACE_CACHE_TTL_MS) refreshMarketplaceJsonInBackground(host, key, cachePath, url)
    return cached.payload
  }
  const payload = await fetchMarketplaceJson(url)
  await fs.mkdir(path.dirname(cachePath), { recursive: true })
  await writeJsonFile(cachePath, { version: 1, savedAt: Date.now(), payload })
  await pruneMarketplaceCache(host)
  return payload
}

/**
 * Delete capability-marketplace cache entries that have aged out.
 *
 * The cache key is the request URL, so every distinct search term, page offset,
 * and opened MCP slug earns its own file in a directory shared with the
 * fixed-name catalogs — and nothing else in this plugin ever enumerates that
 * directory, so the entries only ever accumulated. `MARKETPLACE_CACHE_TTL_MS`
 * governs *freshness*; this is what bounds the directory on disk. Best-effort
 * throughout, and throttled by {@link CommunityRemotesState.marketplaceCachePrunedAt}:
 * a sweep must never fail the read that triggered it, and it must not readdir the
 * cache once per keystroke.
 * @param host - plugin surface; its state carries the sweep throttle.
 */
async function pruneMarketplaceCache(host: CommunityRemotesHost): Promise<void> {
  const now = Date.now()
  if (now - host.state.marketplaceCachePrunedAt < MARKETPLACE_CACHE_PRUNE_INTERVAL_MS) return
  host.state.marketplaceCachePrunedAt = now
  const directory = path.dirname(host.catalogs.catalogCachePath(`${MARKETPLACE_CACHE_PREFIX}sweep.json`))
  let names: readonly string[]
  try { names = await fs.readdir(directory) } catch { return }
  for (const name of names) {
    if (!name.startsWith(MARKETPLACE_CACHE_PREFIX) || !name.endsWith('.json')) continue
    let fresh = false
    try {
      const savedAt = record(await readJsonFile(path.join(directory, name))).savedAt
      fresh = typeof savedAt === 'number' && Number.isFinite(savedAt) && now - savedAt <= MARKETPLACE_CACHE_MAX_AGE_MS
    } catch {
      // An unreadable entry is overwritten by the next miss for its own key.
      continue
    }
    if (fresh) continue
    await fs.rm(path.join(directory, name), { force: true }).catch(() => undefined)
  }
}

function refreshMarketplaceJsonInBackground(host: CommunityRemotesHost, key: string, cachePath: string, url: URL): void {
  if (host.state.marketplaceRefreshPromises.has(key)) return
  const operation = host.catalogs.pendingWrites.run(async () => {
    const payload = await fetchMarketplaceJson(url)
    await fs.mkdir(path.dirname(cachePath), { recursive: true })
    await writeJsonFile(cachePath, { version: 1, savedAt: Date.now(), payload })
    await pruneMarketplaceCache(host)
  }).then(() => undefined, () => undefined)
  host.state.marketplaceRefreshPromises.set(key, operation)
  void operation.finally(() => {
    if (host.state.marketplaceRefreshPromises.get(key) === operation) host.state.marketplaceRefreshPromises.delete(key)
  })
}

async function mcpMarketplaceCategories(host: CommunityRemotesHost): Promise<readonly { readonly id: string; readonly label: string; readonly count?: number }[]> {
  const root = record(record(await marketplaceJson(host, new URL(MCP_SO_CATEGORIES_URL))).data)
  const categories = Array.isArray(root.categories) ? root.categories : []
  return categories.flatMap((value) => {
    const item = record(value)
    const id = marketplaceText(item.slug).toLowerCase()
    const label = marketplaceText(item.name)
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || label === '') return []
    const count = marketplaceNumber(item.serverCount)
    return [{ id, label, ...(count === 0 ? {} : { count }) }]
  })
}

/** Curated, broadly useful MCPs with live MCP.so metadata and install checks. */
async function featuredMcpMarketplace(host: CommunityRemotesHost, configuration: FreeCodeGoCapabilitySettings): Promise<readonly FreeCodeGoCapabilityMarketplaceItem[]> {
  const details = await Promise.all(FREECODEGO_FEATURED_MCP_SLUGS.map(async (slug) => {
    try {
      return { slug, detail: record(record(await marketplaceJson(host, new URL(`${MCP_SO_SERVERS_URL}/${encodeURIComponent(slug)}`))).data) }
    } catch { return undefined }
  }))
  return details.flatMap((entry) => {
    if (entry === undefined) return []
    const definition = marketplaceMcpDefinition(entry.slug, entry.detail)
    const summary = marketplaceMcpSummary(entry.detail, configuration)[0]
    if (summary === undefined) return []
    const requiresConfiguration = definition === undefined || mcpDefinitionRequiresConfiguration(definition)
    const installed = definition !== undefined && configuration.mcpServers.some(server =>
      server.serverName === definition.serverName
      || (definition.transport === 'streamable-http' && server.transport === 'streamable-http' && server.url === definition.url),
    )
    return [{ ...summary, installed, installable: definition !== undefined && !requiresConfiguration, ...(requiresConfiguration ? { requiresConfiguration: true } : {}) }]
  })
}
