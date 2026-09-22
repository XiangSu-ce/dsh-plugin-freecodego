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
import { asRecord as record } from './untrusted-json.ts'
import { communityInstallationLedgerPath, communitySourceKey, installedCommunityPackageNames, readCommunityInstallationLedger, readCommunityRestartMarker, readJsonFile, removeCommunityInstallationLedgerEntry, stringArray, writeCommunityInstallationLedger, writeJsonFile } from './community-storage.ts'
import { commandAvailable, communityInstallTarget, fetchCommunityCatalog, readCommunityCatalogCache, readCommunityIconCache, resolveCommunityRepositoryIcon } from './community-catalog-utils.ts'
import { installSkillFromMarketplace, installedSkillNames, removeSkillFromMarketplace } from './skills/marketplace-install.ts'
import { placementRootId, resolveSkillPlacements, type PlacementContext } from './skills/placement.ts'
import { runDsh } from './plugin-update.ts'
import { fetchMarketplaceJson, marketplaceMcpDefinition, marketplaceMcpSummary, marketplaceNumber, marketplaceSkillSummary, marketplaceText, mcpDefinitionRequiresConfiguration, normalizeMarketplaceRequest, parseMarketplaceId } from './marketplace-utils.ts'
import type { CommunityCatalogPayload, CommunityCatalogPlugin, FreeCodeGoCapabilityMarketplaceItem, FreeCodeGoCapabilityMarketplacePage, FreeCodeGoCapabilityMarketplaceRequest, FreeCodeGoCapabilitySettings, FreeCodeGoCapabilitySnapshot, FreeCodeGoSkillPlacement, FreeCodeGoSkillPlacements } from './types.ts'

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
 * The managed-root id the community Skill root is mounted under.
 *
 * Named rather than spelled at each use because it is an identity, not a path: the
 * capability registry keys a root by id as well as by path, so the id an install
 * mounts has to be the id the page's own list and the removal path look under. It is
 * the id every install before placements used, which is exactly why a placement gets
 * its own id (`placementRootId`) instead of reusing this one — re-enabling this id
 * against another directory unmounts the community root.
 */
export const COMMUNITY_SKILL_ROOT_ID = 'freecodego-community'

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
  /**
   * The roots and the folder trust the placement matrix resolves against.
   *
   * Read through the Host rather than here, because the Host is what knows `$DSH_HOME`,
   * the home directory, and — through the same trust record every other workspace
   * check reads — whether the folder this process runs in has been trusted. A second
   * reader of those facts is a second answer to "is this folder trusted".
   */
  readonly skillPlacementContext: () => Promise<PlacementContext>
}

/** Read one bounded page from the public MCP.so or skills.sh directory. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param input - the caller's kind, query, category, and paging.
 * @returns the capability Marketplace Page.
 */
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
  // Read once per page rather than per row: whether a Skill is installed is the
  // record beside the root, and every row asks the same question of the same file.
  const installed = await installedSkillNamesAcrossRoots(host)
  const items = skills
    .flatMap(value => marketplaceSkillSummary(value, host.communitySkillDirectory(), installed))
    .sort((left, right) => right.popularity - left.popularity)
    .slice(request.offset, request.offset + request.limit)
  return {
    kind: 'skill', total, limit: request.limit, offset: request.offset,
    ...(request.query === '' ? {} : { query: request.query }),
    categories: SKILL_MARKETPLACE_CATEGORIES.map(([id, label]) => ({ id, label })), items,
  }
}

/** Add a public MCP.so entry when its published configuration can be represented by the shared runtime. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param id - the `mcp:`-prefixed marketplace id to install.
 * @returns the capability snapshot the Host reports.
 */
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

/**
 * Every managed root a Skill from this Marketplace could be sitting in.
 *
 * The community root first — it is what every install before placements used, and
 * what the page's own list is built from — then the roots the placement matrix
 * resolves to. The placement rows are recomputed with `projectTrusted: true` on
 * purpose: trust gates *computing a destination from a repository's own
 * configuration*, while this list asks where an install could already be, and a
 * folder that lost its trust after an install must not make that install
 * unremovable.
 *
 * `custom` rows are left out because a custom root is a path the caller supplies,
 * and nothing supplies one through these remotes.
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the roots, deduplicated by path, in the order they should be read.
 */
async function skillManagedRoots(host: CommunityRemotesHost): Promise<readonly { readonly root: string; readonly id: string; readonly provenance: string }[]> {
  const community = { root: host.communitySkillDirectory(), id: COMMUNITY_SKILL_ROOT_ID, provenance: 'the community marketplace root' }
  const rows = resolveSkillPlacements({ ...(await host.skillPlacementContext()), projectTrusted: true })
  const roots = [community]
  for (const row of rows) {
    if (!row.ok || row.agent === 'custom') continue
    if (roots.some(candidate => candidate.root === row.root)) continue
    roots.push({ root: row.root, id: placementRootId(row.agent, row.scope), provenance: row.provenance })
  }
  return roots
}

/** Names the catalog should mark as installed, across every root one could be in. */
async function installedSkillNamesAcrossRoots(host: CommunityRemotesHost): Promise<ReadonlySet<string>> {
  const names = new Set<string>()
  for (const target of await skillManagedRoots(host)) {
    for (const name of await installedSkillNames(target.root)) names.add(name)
  }
  return names
}

/**
 * Resolve where one install should land, and the id its root is mounted under.
 *
 * Absent a placement this is the community root under its original id, which is
 * what every earlier install did: a placement moves the *file*, and re-mounting the
 * list the page reads would be a different change than the one the user asked for.
 * A named placement is resolved through the same matrix the page renders, so an
 * unavailable destination is refused with the matrix's own reason rather than with a
 * path that would have been wrong.
 * @param host - the Host surface this remote call reaches its services through.
 * @param placement - the chosen axes, or absent for the community root.
 * @returns the root, the managed-root id, and how to describe the destination.
 */
async function resolveInstallTarget(host: CommunityRemotesHost, placement: FreeCodeGoSkillPlacement | undefined): Promise<{ readonly root: string; readonly id: string; readonly provenance: string }> {
  if (placement === undefined) {
    return { root: host.communitySkillDirectory(), id: COMMUNITY_SKILL_ROOT_ID, provenance: 'the community marketplace root' }
  }
  const context = await host.skillPlacementContext()
  const row = resolveSkillPlacements(context).find(candidate => candidate.agent === placement.agent && candidate.scope === placement.scope)
  if (row === undefined) throw new Error(`unknown Skill placement ${placement.agent}/${placement.scope}`)
  if (!row.ok) throw new Error(row.reason)
  return { root: row.root, id: placementRootId(placement.agent, placement.scope), provenance: row.provenance }
}

/**
 * The placement matrix, as the settings page shows it.
 *
 * Exposed as its own remote rather than folded into the catalog response, because
 * the rows depend on the *folder* — its trust, and where it is — and a page that read
 * them out of a cached catalog would keep offering a project install after the
 * folder stopped being trusted.
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the resolved rows and the folder they were resolved against.
 */
export async function skillPlacements(host: CommunityRemotesHost): Promise<FreeCodeGoSkillPlacements> {
  const context = await host.skillPlacementContext()
  // The remembered choice is read from the same configuration the install path reads,
  // on the same call that resolves the rows: a page whose selected option came from a
  // second read could show one destination and install into another. The document's
  // explicit `null` (a clear) is not a choice, and `configuration()` has already folded
  // it away — this is the same fold, said once more at the boundary that serializes it.
  const preferred = host.capabilities.configuration().preferredSkillPlacement ?? undefined
  return {
    workspace: context.workspace,
    projectTrusted: context.projectTrusted,
    defaultRoot: host.communitySkillDirectory(),
    ...(preferred === undefined ? {} : { preferred }),
    rows: resolveSkillPlacements(context).map(row => row.ok
      ? { agent: row.agent, scope: row.scope, ok: true, root: row.root, provenance: row.provenance }
      : { agent: row.agent, scope: row.scope, ok: false, reason: row.reason }),
  }
}

/**
 * Install one Skill from a source specifier or a skills.sh marketplace id.
 *
 * The identity is read by `skills/source.ts` first, so a tag, a subdirectory, an
 * npm name or a directory on this machine is a spelling this accepts — the
 * `owner/repo/skill-name` shape the catalog produces is the fallback. The install
 * itself goes through `skills/marketplace-install.ts`, which is where the atomic
 * install, the lockfile pin and the collision refusal live: this function decides
 * what to install, not how it lands.
 *
 * A named placement picks the destination and mounts that root; the file moves, the
 * community list does not. The two axes are resolved against the same matrix the page
 * renders, so a destination the folder cannot support fails here with the reason the
 * page already showed for it.
 * @param host - the Host surface this remote call reaches its services through.
 * @param id - the `skill:`-prefixed marketplace id, or a bare source specifier.
 * @param placement - the destination axes, or absent for the community root.
 * @returns the capability snapshot the Host reports, carrying what the install recorded.
 */
export async function skillPresetInstall(host: CommunityRemotesHost, id: string, placement?: FreeCodeGoSkillPlacement): Promise<FreeCodeGoCapabilitySnapshot> {
  const identity = parseMarketplaceId(id, 'skill')
  const target = await resolveInstallTarget(host, placement)
  const report = await installSkillFromMarketplace({
    identity,
    root: target.root,
    ...(placement === undefined ? {} : { placement: { root: target.root, provenance: target.provenance } }),
  })
  if ('refused' in report) throw new Error(report.refused)
  const snapshot = await host.capabilities.enableManagedSkillRoot(target.id, target.root)
  // Logged as well as returned: a Skill that landed unrecorded is a state the
  // operator has to be able to see in the Host log, not only in one settings page.
  host.ctx.logger.info?.(`freecodego: installed Skill "${report.name}" from ${report.source} (${report.resolvedCommit}) into ${target.provenance}${report.locked ? '' : ' — NOT recorded in the lockfile'}`)
  return { ...snapshot, skillInstall: report }
}

/**
 * Remove one Skill an earlier Marketplace install put in the managed root.
 *
 * The identity is the same one the install took, so the page can offer removal on
 * the card it offered the install on. Which directory that is, is decided by
 * `skills/marketplace-install.ts` — including the flattened directory the previous
 * installer created — because the browser would have to re-derive the sanitizer to
 * name it, and a second copy of that rule is a copy that drifts.
 *
 * The snapshot is **read**, not re-enabled: the root stays mounted, and re-enabling
 * it to refresh a list would be an install-shaped write to answer a question about
 * what the root now holds.
 *
 * Every managed root is searched, because an install that named a placement landed
 * in a different one and the page offers removal on the same card it offered the
 * install on. The first root that holds the Skill is the one it is removed from.
 * @param host - the Host surface this remote call reaches its services through.
 * @param id - the `skill:`-prefixed marketplace id, or a bare source specifier.
 * @returns the capability snapshot, carrying what was removed.
 */
export async function skillPresetRemove(host: CommunityRemotesHost, id: string): Promise<FreeCodeGoCapabilitySnapshot> {
  const identity = parseMarketplaceId(id, 'skill')
  const roots = await skillManagedRoots(host)
  const refusals: string[] = []
  for (const [index, target] of roots.entries()) {
    // The flattened-directory fallback belongs to the community root alone: it is the
    // only root the installer that created those directories ever wrote to, and
    // elsewhere a name must not be enough to authorize deleting a directory.
    const report = await removeSkillFromMarketplace({ identity, root: target.root, ...(index === 0 ? {} : { recordedOnly: true }) })
    if ('refused' in report) { refusals.push(report.refused); continue }
    host.ctx.logger.info?.(`freecodego: removed Skill "${report.name}"${report.source === undefined ? '' : ` from ${report.source}`} out of ${target.provenance} — ${report.detail}`)
    return { ...(await host.capabilities.snapshot()), skillRemove: report }
  }
  // Every root refused. A root that names this Skill under a *different* source has
  // told the user something a plain absence has not, and the page renders one
  // message: the substantive refusal wins over "not installed here".
  const notHere = /is not installed in this managed root/u
  throw new Error(refusals.find(reason => !notHere.test(reason)) ?? refusals[0] ?? `"${identity}" is not installed in any managed Skill root`)
}

/** Public, credential-free community catalog used by the embedded settings page. 
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the community Catalog Payload.
 */
export async function communityCatalog(host: CommunityRemotesHost): Promise<CommunityCatalogPayload> {
  if (host.state.communityCatalogPromise !== undefined) return host.state.communityCatalogPromise
  const operation = loadCommunityCatalog(host)
  host.state.communityCatalogPromise = operation
  try { return await operation } finally {
    if (host.state.communityCatalogPromise === operation) host.state.communityCatalogPromise = undefined
  }
}

/** Resolve only verified repository artwork; never synthesize a plugin identity.
 * @param host - the Host surface this remote call reaches its services through.
 * @param urls - the catalog source URLs to resolve icons for.
 * @returns each resolvable URL mapped to its icon URL.
 */
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

/** Report whether the community install prerequisites are present, plus the runtime identity.
 * @param host - the Host surface this remote call reaches its services through.
 * @returns whether the environment is ready and the platform/node/profile details.
 */
export async function communityEnvironment(host: CommunityRemotesHost): Promise<{ readonly ready: boolean; readonly platform: string; readonly node: string; readonly profile: string }> {
  const ready = await commandAvailable('pnpm')
  return { ready, platform: `${process.platform}-${process.arch}`, node: process.version, profile: host.communityProfileDirectory() }
}

/** List the community plugins installed in the profile and their activation state.
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the installed packages, activation states, sources, and restart flag.
 */
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

/** Install one community plugin into the profile, serialized against other mutations.
 * @param host - the Host surface this remote call reaches its services through.
 * @param url - the plugin source URL to install.
 * @returns the installed package names and the restart requirement.
 */
export async function communityInstall(host: CommunityRemotesHost, url: string): Promise<{ readonly ok: true; readonly packageNames: readonly string[]; readonly restartRequired: true }> {
  if (host.state.communityMutationTask !== undefined) throw new Error('another community plugin operation is already running')
  const task = installCommunityPlugin(host, url)
  host.state.communityMutationTask = task
  try { return await task } finally { host.state.communityMutationTask = undefined }
}

/** Remove an installed community plugin from the running profile and its next boot. 
 * @param host - the Host surface this remote call reaches its services through.
 * @param url - absolute URL the request is sent to.
 * @returns the removed package names and the restart requirement.
 */
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

/**
 * The profile name a profile directory belongs to, as `dsh plugin --profile`
 * wants it.
 *
 * The CLI reconciles the manifest of the profile it is *named*, while this
 * module inspects the directory it *resolved*; deriving the name from that same
 * directory is what keeps the two the same profile instead of two writers
 * editing different files. A directory that yields no usable name is a refusal
 * rather than a guess.
 * @param directory - the profile directory this module resolved.
 * @returns the profile name to hand the CLI.
 */
function profileNameFor(directory: string): string {
  const name = path.basename(path.resolve(directory))
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error(`community profile directory has no usable profile name: ${directory}`)
  return name
}

/**
 * Run one community package operation through the Harness CLI.
 *
 * Every profile manifest edit — the dependency and the `dsh.profile.bundles`
 * entry that activates it — belongs to `dsh plugin`, so this is the only place
 * the community marketplace touches a profile's packages.
 * @param directory - the profile directory the operation targets.
 * @param args - the pnpm arguments after `plugin`.
 * @throws when the CLI exits non-zero, with its output masked.
 */
async function runProfilePluginCommand(directory: string, args: readonly string[]): Promise<void> {
  const result = await runDsh(profileNameFor(directory), args)
  if (result.code !== 0) throw new Error(redactCredentialShapes(result.detail) || `dsh plugin exited with code ${String(result.code)}`)
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
  // The install, the dependency entry, and the `dsh.profile.bundles` line that
  // activates the bundle are one operation owned by the CLI. Editing any of them
  // here would make this module a second writer of the same manifest.
  await runProfilePluginCommand(directory, ['add', target])
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
  // under a known name. The CLI activates as it installs, so a package this
  // scan refuses has already been named as a profile layer by the time the scan
  // can read it — the rejection therefore has to *take that back* before it is
  // returned, or the next start mounts the hostile package anyway.
  try {
    await rescanUpdatedCommunityAssets(directory, packageNames)
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error)
    const rollback = await undoFailedActivation(host, directory, packageNames, added)
      .then(() => undefined, (cause: unknown) => redactCredentialShapes(cause instanceof Error ? cause.message : String(cause)))
    throw new Error(rollback === undefined ? failure : `${failure}; undoing the activation also failed: ${rollback}`)
  }
  if (packageNames.length > 0) {
    await writeCommunityInstallationLedger(communityInstallationLedgerPath(directory), entry.url, packageNames)
    const markerPath = path.join(directory, '.dsh-market', 'restart-pending.json')
    await fs.mkdir(path.dirname(markerPath), { recursive: true })
    await writeJsonFile(markerPath, { version: 1, processId: process.pid, runtimeStartTime: host.communityRuntimeStartTime(), packageNames })
  }
  return { ok: true, packageNames, restartRequired: true as const }
}

/**
 * Take back the activation a rejected install already performed.
 *
 * A package this install newly added is removed through the same CLI, which
 * restores both the dependency and the bundle list to what they were: the next
 * start loads exactly what it loaded before. A name that was already a dependency
 * is the update case, and there is no previous version here to restore to (the
 * release flow is what retains one), so its loader entries are disabled instead —
 * the copy stays on disk but cannot be loaded, and the caller still receives the
 * scan's rejection.
 * @param host - the Host surface used to reach the loader.
 * @param directory - the profile directory the install targeted.
 * @param packageNames - every package this install touched.
 * @param added - the subset of those it newly added.
 * @returns nothing; a failed undo rejects, and the caller reports it alongside
 * the scan's own verdict rather than replacing it.
 */
async function undoFailedActivation(host: CommunityRemotesHost, directory: string, packageNames: readonly string[], added: readonly string[]): Promise<void> {
  const fresh = packageNames.filter(name => added.includes(name))
  const retained = packageNames.filter(name => !added.includes(name))
  if (retained.length > 0) await disableCommunityEntries(host, retained)
  if (fresh.length === 0) return
  await runProfilePluginCommand(directory, ['remove', ...fresh])
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
  // loader entries disabled in the profile when the removal itself fails. The
  // CLI drops each removed name from `dsh.profile.bundles` in the same
  // operation, so the manifest is not edited here.
  await runProfilePluginCommand(directory, ['remove', ...packageNames])
  await disableCommunityEntries(host, packageNames)
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
