import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { CapabilityDetailModal, type CapabilityDetailItem } from './capability-detail.tsx'
import { capabilityText, upstreamEnglishHint } from './capability-locale.ts'
import { usePluginReadme } from './plugin-readme.ts'
import css from './settings-tab.module.css'

interface RegistryPlugin {
  readonly name: string
  readonly owner: string
  readonly url: string
  readonly category: string | readonly string[]
  readonly iconUrl?: string
  readonly screenshots?: readonly string[]
  readonly description?: { readonly zh?: string; readonly en?: string }
  readonly npm?: string | null
  readonly stars?: number | null
  readonly downloads?: number | null
  readonly added?: string
  readonly featureNames?: readonly string[]
  readonly searchText?: string
}

interface InstalledPayload {
  readonly installed?: Record<string, string>
  readonly activation?: Record<string, { readonly state?: string; readonly reasons?: readonly string[] }>
  readonly sources?: Record<string, readonly string[]>
  readonly restartRequired?: boolean
}

interface CommunityApi {
  readonly communityCatalog: () => Promise<RemoteResult<{ readonly updated?: string; readonly plugins: readonly { readonly name: string; readonly owner: string; readonly url: string; readonly category: string | readonly string[]; readonly iconUrl?: string; readonly screenshots?: readonly string[]; readonly description?: { readonly zh?: string; readonly en?: string }; readonly npm?: string; readonly stars?: number; readonly downloads?: number; readonly added?: string }[] }>>
  readonly communityCatalogIcons?: ((urls: readonly string[]) => Promise<RemoteResult<Readonly<Record<string, string>>>>) | undefined
  readonly communityEnvironment: () => Promise<RemoteResult<{ readonly ready: boolean; readonly platform: string; readonly node: string; readonly profile: string }>>
  readonly communityInstalled: () => Promise<RemoteResult<InstalledPayload>>
  readonly communityInstall: (url: string) => Promise<RemoteResult<{ readonly ok: true; readonly packageNames: readonly string[]; readonly restartRequired: true }>>
  readonly communityUninstall?: ((url: string) => Promise<RemoteResult<{ readonly ok: true; readonly packageNames: readonly string[]; readonly restartRequired: true }>>) | undefined
  readonly capabilityMarketplace: (input: CapabilityMarketplaceRequest) => Promise<RemoteResult<CapabilityMarketplacePage>>
  readonly mcpPresetInstall: (id: string) => Promise<RemoteResult<unknown>>
  readonly skillPresetInstall: (id: string) => Promise<RemoteResult<unknown>>
  readonly language: 'zh' | 'en'
}

interface CapabilityMarketplaceRequest { readonly kind: 'mcp' | 'skill'; readonly query?: string; readonly category?: string; readonly offset?: number; readonly limit?: number }
interface CapabilityMarketplaceItem {
  readonly id: string
  readonly kind: 'mcp' | 'skill'
  readonly title: string
  readonly description: string
  readonly category: string
  readonly sourceUrl: string
  readonly iconUrl?: string
  readonly author?: string
  readonly popularity: number
  readonly installed: boolean
  readonly installable: boolean
  readonly requiresConfiguration?: boolean
}
interface CapabilityMarketplacePage { readonly kind: 'mcp' | 'skill'; readonly total: number; readonly offset: number; readonly limit: number; readonly query?: string; readonly categories: readonly { readonly id: string; readonly label: string; readonly count?: number }[]; readonly items: readonly CapabilityMarketplaceItem[] }

interface CapabilityToggleSnapshot {
  readonly mcpEnabled: boolean
  readonly skillEnabled: boolean
}

const CATEGORY_ZH: Readonly<Record<string, string>> = {
  'ai & agents': 'AI 与智能体', reasoning: '推理', 'memory & knowledge': '记忆与知识', search: '搜索',
  'browser automation': '浏览器自动化', 'data & analytics': '数据与分析', 'developer tools': '开发工具',
  'version control': '版本控制', productivity: '生产力', databases: '数据库', 'cloud & infrastructure': '云与基础设施',
  'files & storage': '文件与存储', communication: '沟通协作', 'media & design': '媒体与设计',
  'finance & commerce': '金融与商务', other: '其他', community: '社区',
}

function localizeCategory(value: string, language: 'zh' | 'en'): string {
  return language === 'zh' ? CATEGORY_ZH[value.toLowerCase()] ?? value : value
}

function CapabilityIcon({ item }: { readonly item: CapabilityMarketplaceItem }): ReactNode {
  const [failed, setFailed] = useState(false)
  if (item.iconUrl !== undefined && !failed) return <img className={css.capabilityIcon} src={item.iconUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => { setFailed(true) }} />
  if (item.kind === 'mcp') return <span className={`${css.capabilityIcon} ${css.capabilityIconMcp}`} aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="3" cy="8" r="1.7" fill="currentColor" /><circle cx="13" cy="3" r="1.7" fill="currentColor" /><circle cx="13" cy="13" r="1.7" fill="currentColor" /><path d="M4.5 7.2 11.5 3.8M4.5 8.8l7 3.4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" /></svg></span>
  return <span className={css.capabilityIcon} aria-hidden="true">S</span>
}

interface PluginState {
  readonly loading: boolean
  readonly catalog: readonly RegistryPlugin[]
  readonly plugins: readonly RegistryPlugin[]
  /** Merged-entry count before the display cap, so the page can say what it hid. */
  readonly marketTotal: number
  readonly iconUrls: Readonly<Record<string, string>>
  readonly registryUpdated: string | undefined
  readonly githubProxy: string | null
  readonly installed: Record<string, string>
  readonly installedSources: Record<string, readonly string[]>
  readonly activation: Record<string, { readonly state?: string; readonly reasons?: readonly string[] }>
  readonly busyUrl: string | undefined
  readonly phase: string | undefined
  readonly currentPackage: string | undefined
  readonly seconds: number | undefined
  readonly environmentReady: boolean | undefined
  readonly restartNeeded: boolean
  readonly error: string | undefined
}

/** How many merged repository entries the market grid renders before the cap. */
const MARKET_ENTRY_LIMIT = 50

const INITIAL_STATE: PluginState = {
  loading: true,
  catalog: [],
  plugins: [],
  marketTotal: 0,
  iconUrls: {},
  registryUpdated: undefined,
  githubProxy: null,
  installed: {},
  installedSources: {},
  activation: {},
  busyUrl: undefined,
  phase: undefined,
  currentPackage: undefined,
  seconds: undefined,
  environmentReady: undefined,
  restartNeeded: false,
  error: undefined,
}

function categories(plugin: RegistryPlugin): readonly string[] {
  return typeof plugin.category === 'string' ? [plugin.category] : plugin.category
}

function packageNames(plugin: RegistryPlugin): readonly string[] {
  return [plugin.npm, plugin.name].filter((value): value is string => typeof value === 'string' && value.trim() !== '')
}

function installedName(plugin: RegistryPlugin, installed: Record<string, string>, sources: Record<string, readonly string[]>): string | undefined {
  const sourcePackages = sources[plugin.url.trim().toLowerCase()] ?? []
  return [...sourcePackages, ...packageNames(plugin)].find(name => installed[name] !== undefined)
}

function isTerminalPlugin(plugin: RegistryPlugin): boolean {
  const text = `${plugin.name} ${plugin.description?.en ?? ''} ${plugin.description?.zh ?? ''}`.toLowerCase()
  return /\b(tui|tty|terminal|cli)\b|终端|命令行/.test(text)
}

function formatCount(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : String(value)
}

function popularityScore(plugin: RegistryPlugin): number {
  const downloads = typeof plugin.downloads === 'number' && Number.isFinite(plugin.downloads) ? plugin.downloads : 0
  const stars = typeof plugin.stars === 'number' && Number.isFinite(plugin.stars) ? plugin.stars : 0
  // Downloads are the strongest popularity signal; stars keep quality-focused
  // GitHub-only projects visible even when npm has no download telemetry.
  return Math.log10(downloads + 1) * 1000 + stars * 25
}

function repositoryKey(plugin: RegistryPlugin): string {
  try {
    const url = new URL(plugin.url)
    const parts = url.pathname.split('/').filter(Boolean)
    if (url.hostname.toLowerCase() === 'github.com' && parts.length >= 2) return `github:${parts[0]!.toLowerCase()}/${parts[1]!.replace(/\.git$/i, '').toLowerCase()}`
  } catch { /* fall through to package identity */ }
  return plugin.npm === null || plugin.npm === undefined || plugin.npm.trim() === ''
    ? `url:${plugin.url.toLowerCase()}`
    : `npm:${plugin.npm.toLowerCase()}`
}

/** Collapse monorepo feature rows into one installable aggregate card. */
function mergeRepositoryEntries(entries: readonly RegistryPlugin[]): RegistryPlugin[] {
  const buckets = new Map<string, RegistryPlugin[]>()
  for (const entry of entries) {
    const bucket = buckets.get(repositoryKey(entry)) ?? []
    bucket.push(entry)
    buckets.set(repositoryKey(entry), bucket)
  }
  return [...buckets.values()].map((bucket) => {
    const winner = [...bucket].sort((left, right) => {
      const npmBias = Number(Boolean(right.npm)) - Number(Boolean(left.npm))
      return npmBias || popularityScore(right) - popularityScore(left)
    })[0]!
    const featureNames = [...new Set(bucket.map(entry => entry.name).filter(name => name !== winner.name))]
    const searchText = bucket.flatMap(entry => [entry.name, entry.npm ?? '', entry.owner, entry.description?.zh ?? '', entry.description?.en ?? '']).join(' ').toLowerCase()
    return { ...winner, ...(featureNames.length === 0 ? {} : { featureNames }), searchText }
  }).sort((left, right) => popularityScore(right) - popularityScore(left))
}

function repositoryOwner(plugin: RegistryPlugin): string {
  try {
    const url = new URL(plugin.url)
    if (url.hostname.toLowerCase() === 'github.com') {
      const owner = url.pathname.split('/').filter(Boolean)[0]
      if (owner !== undefined && owner !== '') return owner
    }
  } catch { /* Use the catalog owner below. */ }
  return plugin.owner.trim()
}

function authorAvatarUrl(plugin: RegistryPlugin): string | undefined {
  const owner = repositoryOwner(plugin)
  // GitHub account names are deliberately constrained before interpolation.
  if (owner === '' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(owner)) return undefined
  return `https://avatars.githubusercontent.com/${encodeURIComponent(owner)}?size=96`
}

function PluginIcon({ plugin, iconUrl }: { readonly plugin: RegistryPlugin; readonly iconUrl: string | undefined }): ReactNode {
  const [catalogFailed, setCatalogFailed] = useState(false)
  const [avatarFailed, setAvatarFailed] = useState(false)
  const avatarUrl = authorAvatarUrl(plugin)
  useEffect(() => { setCatalogFailed(false) }, [iconUrl])
  if (iconUrl !== undefined && !catalogFailed) return <img className={css.communityPluginIcon} data-fcg-plugin-icon="catalog" src={iconUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => { setCatalogFailed(true) }} />
  if (avatarUrl !== undefined && !avatarFailed) return <img className={css.communityPluginIcon} data-fcg-plugin-icon="author" src={avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => { setAvatarFailed(true) }} />
  return null
}

function activationLabel(state: string | undefined, language: 'zh' | 'en'): string {
  if (language === 'zh') {
    if (state === 'live') return '已生效'
    if (state === 'restart') return '重启后生效'
    if (state === 'disabled') return '已停用'
    if (state === 'broken') return '加载失败'
    return '已安装'
  }
  if (state === 'live') return 'Active'
  if (state === 'restart') return 'Active after restart'
  if (state === 'disabled') return 'Disabled'
  if (state === 'broken') return 'Failed to load'
  return 'Installed'
}

function localizedPluginDescription(plugin: RegistryPlugin, language: 'zh' | 'en'): string {
  return language === 'zh'
    ? plugin.description?.zh ?? plugin.description?.en ?? '社区插件'
    : plugin.description?.en ?? plugin.description?.zh ?? 'Community plugin'
}

/** Whether the shown description is the requested language's own text. */
function pluginDescriptionLocalized(plugin: RegistryPlugin, language: 'zh' | 'en'): boolean {
  if (language !== 'zh') return true
  return (plugin.description?.zh ?? '').trim() !== ''
}

function remoteValue<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

export function CommunityPluginsPage({ communityCatalog, communityCatalogIcons, communityEnvironment, communityInstalled, communityInstall, communityUninstall, capabilityMarketplace, mcpPresetInstall, skillPresetInstall, language }: CommunityApi): ReactNode {
  const isZh = language === 'zh'
  const text = isZh ? {
    installed: '已安装插件', popular: '社区热门插件', installedIntro: '管理已通过社区页加入当前 Profile 的插件，可在此直接卸载。', marketIntro: '根据市场下载量与 Stars 动态排行，安装由本机 Harness 安全完成。', updatedAt: '目录更新于', refresh: '刷新', categories: '社区能力分类', plugin: '插件', backToCommunity: '返回社区', searchInstalled: '搜索已安装插件', searchMarket: '搜索社区插件', searchPlaceholder: '名称、作者、功能、npm 包名', noPnpm: '未检测到 pnpm，当前电脑环境无法安装社区插件，请先安装 pnpm 后刷新。', marketError: '插件市场服务不可用：', capabilityError: '添加失败：', loading: '正在读取精选插件…', restartNotice: '插件安装或卸载后，部分改动需要重启 Harness 才会生效。', restartNow: '立即重启', emptyMarket: '精选目录暂时没有可用条目。', emptyInstalled: '当前 Profile 尚未安装可识别的社区插件。', featureCount: (count: number) => `包含 ${count} 个同仓库功能`, terminalOnly: '仅支持 TUI Profile', installing: '安装中', uninstalling: '卸载中', install: '一键安装', uninstall: '卸载', installedCount: (count: number) => `已安装插件 ${count} 个`, marketCount: (count: number) => `当前显示 ${count} 个社区条目`, marketTruncated: (total: number, shown: number) => `（目录共 ${total} 个，此处按下载量排行显示前 ${shown} 个）`, searchCount: (count: number) => `搜索结果 ${count} 个`, usableCount: (count: number) => `，其中 ${count} 个可用于 Web/Host。`, close: '关闭', modalFeatureCount: '同仓库功能：', openProject: '打开项目主页', readmeLoading: '正在读取完整功能介绍…', readmeChinese: '已优先显示上游中文说明。', readmeEmpty: '暂无 README 内容。', readmeError: '暂时无法读取插件 README，请打开项目主页查看完整说明。',
  } : {
    installed: 'Installed plugins', popular: 'Popular community plugins', installedIntro: 'Manage plugins added to this profile from Community. You can uninstall them here.', marketIntro: 'Ranked from marketplace downloads and stars. Installation is handled safely by the local Harness.', updatedAt: 'Directory updated', refresh: 'Refresh', categories: 'Community capability categories', plugin: 'Plugins', backToCommunity: 'Back to community', searchInstalled: 'Search installed plugins', searchMarket: 'Search community plugins', searchPlaceholder: 'Name, author, feature, or npm package', noPnpm: 'pnpm was not detected, so this computer cannot install community plugins. Install pnpm and refresh.', marketError: 'Plugin marketplace is unavailable:', capabilityError: 'Failed to add: ', loading: 'Loading featured plugins…', restartNotice: 'Some changes take effect after Harness restarts.', restartNow: 'Restart now', emptyMarket: 'No featured entries are currently available.', emptyInstalled: 'No recognizable community plugins are installed in this profile.', featureCount: (count: number) => `${count} additional features in this repository`, terminalOnly: 'TUI profile only', installing: 'Installing', uninstalling: 'Uninstalling', install: 'Install', uninstall: 'Uninstall', installedCount: (count: number) => `${count} installed plugins`, marketCount: (count: number) => `${count} community entries shown`, marketTruncated: (total: number, shown: number) => ` (${total} entries in the directory; the top ${shown} by downloads are listed here)`, searchCount: (count: number) => `${count} search results`, usableCount: (count: number) => `; ${count} available to Web/Host`, close: 'Close', modalFeatureCount: 'Repository features:', openProject: 'Open project page', readmeLoading: 'Loading the full feature overview…', readmeChinese: 'Upstream Chinese description preferred and shown.', readmeEmpty: 'No README content is available.', readmeError: 'The plugin README could not be read. Open the project page for the complete details.',
  }
  const [state, setState] = useState<PluginState>(INITIAL_STATE)
  const [selectedPlugin, setSelectedPlugin] = useState<RegistryPlugin | undefined>(undefined)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [filter, setFilter] = useState<'plugin' | 'mcp' | 'skill'>('plugin')
  const [pluginView, setPluginView] = useState<'market' | 'installed'>('market')
  const [marketplace, setMarketplace] = useState<CapabilityMarketplacePage | undefined>(undefined)
  const [marketplaceLoading, setMarketplaceLoading] = useState(false)
  /** Directory-scoped failure; must not leak into the plugin catalog's global error banner. */
  const [marketplaceError, setMarketplaceError] = useState<string | undefined>(undefined)
  /** Install-scoped failure of one MCP/Skill entry, kept apart from the catalog's
   *  own error banner: that banner names the marketplace service, and an install
   *  that failed after the marketplace answered is not the marketplace being down. */
  const [capabilityError, setCapabilityError] = useState<string | undefined>(undefined)
  const [marketplaceCategory, setMarketplaceCategory] = useState('')
  const [marketplaceOffset, setMarketplaceOffset] = useState(0)
  const [capabilityBusy, setCapabilityBusy] = useState<string | undefined>(undefined)
  const [selectedCapability, setSelectedCapability] = useState<CapabilityMarketplaceItem | undefined>(undefined)
  // Upstream README for the plugin dialog, Chinese first when the UI is Chinese.
  const readme = usePluginReadme(selectedPlugin?.url, language)
  const modalCloseRef = useRef<HTMLButtonElement | null>(null)
  /** Monotonic token: a slower earlier load() must not overwrite a newer one. */
  const loadToken = useRef(0)

  const resolveCatalogIcons = (plugins: readonly RegistryPlugin[]): void => {
    if (communityCatalogIcons === undefined) return
    const urls = plugins.filter(plugin => plugin.iconUrl === undefined && plugin.screenshots?.[0] === undefined).slice(0, 24).map(plugin => plugin.url)
    if (urls.length === 0) return
    void communityCatalogIcons(urls).then(remoteValue).then((iconUrls) => {
      if (Object.keys(iconUrls).length === 0) return
      setState(previous => ({ ...previous, iconUrls: { ...previous.iconUrls, ...iconUrls } }))
    }).catch(() => {
      // Repository artwork is optional and must never turn the catalog into an error state.
    })
  }

  const load = async (restartRequired = false): Promise<void> => {
    const token = ++loadToken.current
    setState(previous => ({ ...previous, loading: true, error: undefined }))
    try {
      const [registry, installed, environment] = await Promise.all([
        communityCatalog().then(remoteValue),
        communityInstalled().then(remoteValue),
        communityEnvironment().then(remoteValue),
      ])
      if (token !== loadToken.current) return
      const catalog = registry.plugins.map(value => value as unknown as RegistryPlugin)
        .filter(plugin => plugin.npm !== 'dshmarket' && plugin.name !== 'dsh-market')
      // The page shows a ranked top-N, but a hard cap with no total reads as
      // "this is everything". Keep the pre-cap count so the footnote can say so.
      const merged = mergeRepositoryEntries(catalog)
      const plugins = merged.slice(0, MARKET_ENTRY_LIMIT)
      const activation = installed.activation ?? {}
      setState({
        loading: false,
        catalog,
        plugins,
        marketTotal: merged.length,
        iconUrls: {},
        registryUpdated: registry.updated,
        githubProxy: null,
        installed: installed.installed ?? {},
        installedSources: installed.sources ?? {},
        activation,
        busyUrl: undefined,
        phase: undefined,
        currentPackage: undefined,
        seconds: undefined,
        environmentReady: environment.ready,
        restartNeeded: restartRequired || installed.restartRequired === true || Object.values(activation).some(entry => entry.state === 'restart'),
        error: undefined,
      })
      resolveCatalogIcons(plugins)
    } catch (error) {
      if (token !== loadToken.current) return
      setState(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : String(error) }))
    }
  }

  useEffect(() => { void load() }, [])

  // A Host restart can happen while this page remains mounted. In that case
  // the initial snapshot still contains the pre-restart banner, so poll the
  // small installation endpoint until the new Host reports every package as
  // live. Do not reload the full catalog here: this check must remain cheap
  // and resilient to a temporarily unavailable RPC connection.
  const installedCall = useRef(communityInstalled)
  useEffect(() => { installedCall.current = communityInstalled })
  useEffect(() => {
    if (!state.restartNeeded) return
    let active = true
    let inFlight = false
    let consecutiveFailures = 0
    // `ReturnType`, not `number`: the DOM shape returns a number while the Node
    // shape returns a Timeout object, and this file must type-check under both
    // (the package build is browser-shaped, the test project is not).
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      try {
        const installed = await installedCall.current().then(remoteValue)
        if (!active) return
        consecutiveFailures = 0
        const activation = installed.activation ?? {}
        setState(previous => ({
          ...previous,
          installed: installed.installed ?? previous.installed,
          activation,
          restartNeeded: installed.restartRequired ?? Object.values(activation).some(entry => entry.state === 'restart'),
        }))
      } catch {
        consecutiveFailures += 1
        // Keep the banner until the Host can be queried successfully.
      } finally {
        inFlight = false
      }
    }
    const run = async (): Promise<void> => {
      // Background tabs do not need the restart-banner poll; the next tick
      // after the tab becomes visible refreshes the state.
      if (document.visibilityState !== 'hidden') await check()
      if (!active) return
      // A Host that is down (restarting or crashed) must not absorb one
      // request every 2s forever: back off up to a 30s interval while failing.
      const delay = consecutiveFailures === 0 ? 2_000 : Math.min(30_000, 2_000 * 2 ** Math.min(consecutiveFailures, 4))
      timer = globalThis.setTimeout(() => { void run() }, delay)
    }
    void run()
    return () => {
      active = false
      if (timer !== undefined) globalThis.clearTimeout(timer)
    }
  }, [state.restartNeeded])

  // The install card renders an elapsed-seconds readout; without this ticker
  // the counter stays at "0s · resolving" for the whole installation.
  useEffect(() => {
    if (state.busyUrl === undefined) return
    const startedAt = Date.now()
    const timer = globalThis.setInterval(() => {
      setState(previous => ({ ...previous, seconds: Math.floor((Date.now() - startedAt) / 1_000) }))
    }, 1_000)
    return () => { globalThis.clearInterval(timer) }
  }, [state.busyUrl])

  useEffect(() => {
    if (filter === 'plugin') { setMarketplace(undefined); return }
    // Debounce the marketplace query so typing does not fire one network
    // request per keystroke; the trailing 300ms value feeds the fetch effect.
    const timer = globalThis.setTimeout(() => { setDebouncedQuery(searchQuery.trim()) }, 300)
    return () => { globalThis.clearTimeout(timer) }
  }, [searchQuery])
  useEffect(() => {
    if (filter === 'plugin') { setMarketplace(undefined); setMarketplaceError(undefined); return }
    let active = true
    setMarketplaceLoading(true)
    void capabilityMarketplace({ kind: filter, query: debouncedQuery, category: marketplaceCategory, offset: marketplaceOffset, limit: 24 }).then((result) => {
      if (!active) return
      if (result.ok) { setMarketplace(result.value); setMarketplaceError(undefined) }
      else setMarketplaceError(result.error.message)
    }, (error: unknown) => { if (active) setMarketplaceError(error instanceof Error ? error.message : String(error)) }).finally(() => { if (active) setMarketplaceLoading(false) })
    return () => { active = false }
  }, [capabilityMarketplace, filter, marketplaceCategory, marketplaceOffset, debouncedQuery])

  useEffect(() => {
    if (selectedPlugin === undefined) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setSelectedPlugin(undefined)
    }
    document.addEventListener('keydown', closeOnEscape)
    queueMicrotask(() => { modalCloseRef.current?.focus() })
    return () => {
      document.removeEventListener('keydown', closeOnEscape)
      opener?.focus()
    }
  }, [selectedPlugin])

  const install = async (plugin: RegistryPlugin): Promise<void> => {
    if (isTerminalPlugin(plugin)) return
    setState(previous => ({ ...previous, busyUrl: plugin.url, phase: 'resolving', seconds: 0, error: undefined }))
    try {
      const result = await communityInstall(plugin.url).then(remoteValue)
      setState(previous => ({
        ...previous,
        busyUrl: undefined,
        restartNeeded: previous.restartNeeded || result.restartRequired,
      }))
      await load()
    } catch (error) {
      setState(previous => ({ ...previous, busyUrl: undefined, error: error instanceof Error ? error.message : String(error) }))
    }
  }

  const uninstall = async (plugin: RegistryPlugin): Promise<void> => {
    if (communityUninstall === undefined) return
    setState(previous => ({ ...previous, busyUrl: plugin.url, phase: 'uninstalling', seconds: undefined, error: undefined }))
    try {
      const result = await communityUninstall(plugin.url).then(remoteValue)
      await load(result.restartRequired)
    } catch (error) {
      setState(previous => ({ ...previous, busyUrl: undefined, error: error instanceof Error ? error.message : String(error) }))
    }
  }

  const restart = (): void => { globalThis.location.reload() }

  const installCapability = async (item: CapabilityMarketplaceItem): Promise<void> => {
    setCapabilityBusy(item.id)
    setCapabilityError(undefined)
    try {
      const result = item.kind === 'mcp'
        ? await mcpPresetInstall(item.id)
        : await skillPresetInstall(item.id)
      const snapshot = remoteValue(result) as CapabilityToggleSnapshot
      globalThis.dispatchEvent(new CustomEvent<CapabilityToggleSnapshot>('freecodego:capability-change', { detail: snapshot }))
      setMarketplace(previous => previous === undefined ? previous : { ...previous, items: previous.items.map(current => current.id === item.id ? { ...current, installed: true } : current) })
      // The grid behind the dialog now shows "added"; keeping a stale dialog open
      // would leave an install button for work that just finished.
      setSelectedCapability(undefined)
    } catch (error) {
      setCapabilityError(error instanceof Error ? error.message : String(error))
    } finally {
      setCapabilityBusy(undefined)
    }
  }

  const installedPlugins = useMemo(() => mergeRepositoryEntries(state.catalog)
    .filter(plugin => installedName(plugin, state.installed, state.installedSources) !== undefined), [state.catalog, state.installed, state.installedSources])
  const visiblePlugins = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    const all = pluginView === 'installed' ? installedPlugins : state.plugins
    const source = query === '' ? all : all.filter(plugin => (plugin.searchText ?? '').includes(query))
    return filter === 'plugin' ? source : []
  }, [filter, installedPlugins, pluginView, searchQuery, state.plugins])
  const visibleReadyCount = useMemo(() => visiblePlugins.filter(plugin => !isTerminalPlugin(plugin)).length, [visiblePlugins])
  const selectFilter = (next: 'plugin' | 'mcp' | 'skill'): void => {
    setFilter(next)
    if (next !== 'plugin') setPluginView('market')
    setMarketplaceCategory('')
    setMarketplaceOffset(0)
    setCapabilityError(undefined)
  }

  return <section className={css.community} aria-busy={state.loading || state.busyUrl !== undefined}>
    <div className={css.communityHeader}>
      <div><div className={css.kicker}>{pluginView === 'installed' ? 'INSTALLED COMMUNITY PLUGINS' : 'POPULAR FROM DSH MARKET'}</div><strong className={css.sectionName}>{pluginView === 'installed' ? text.installed : text.popular}</strong><p className={css.communityIntro}>{pluginView === 'installed' ? text.installedIntro : `${text.marketIntro}${state.registryUpdated === undefined ? '' : ` ${text.updatedAt} ${state.registryUpdated}`}`}</p></div>
      <button className={css.button} type="button" onClick={() => { void load() }} disabled={state.loading || state.busyUrl !== undefined}>{text.refresh}</button>
    </div>
    <div className={css.communityFilterBar}>
      <div className={css.communityFilters} role="tablist" aria-label={text.categories}>
        {([['plugin', text.plugin], ['mcp', 'MCP'], ['skill', 'Skills']] as const).map(([id, label]) => <button className={`${css.communityFilter} ${filter === id ? css.communityFilterActive : ''}`} type="button" role="tab" aria-selected={filter === id} key={id} onClick={() => { selectFilter(id) }}>{label}</button>)}
      </div>
      {filter === 'plugin' ? <button className={`${css.communityInstalledEntry} ${pluginView === 'installed' ? css.communityInstalledEntryActive : ''}`} type="button" onClick={() => { setPluginView(current => current === 'installed' ? 'market' : 'installed') }} aria-pressed={pluginView === 'installed'}>{pluginView === 'installed' ? text.backToCommunity : `${text.installed}${installedPlugins.length === 0 ? '' : ` (${installedPlugins.length})`}`}</button> : null}
    </div>
    {filter === 'plugin' ? <label className={css.communitySearch}><span>{pluginView === 'installed' ? text.searchInstalled : text.searchMarket}</span><input className={css.input} type="search" value={searchQuery} onChange={(event) => { setSearchQuery(event.target.value) }} placeholder={text.searchPlaceholder} /></label> : <section className={css.capabilityCommunity} aria-label={`${filter} marketplace`}>
      <div className={css.capabilityCommunityHeader}><div><div className={css.kicker}>{filter === 'mcp' ? 'MCP.SO DIRECTORY' : 'SKILLS.SH DIRECTORY'}</div><strong className={css.sectionName}>{filter === 'mcp' ? (isZh ? 'MCP 社区目录' : 'MCP Community Directory') : (isZh ? 'Skills 社区目录' : 'Skills Community Directory')}</strong></div><small className={css.sectionMeta}>{marketplace === undefined ? (isZh ? '正在连接社区目录…' : 'Connecting to the community directory…') : `${marketplace.total.toLocaleString()} ${isZh ? '个条目' : 'entries'}`}</small></div>
      <div className={css.marketplaceControls}><input className={css.input} type="search" value={searchQuery} onChange={(event) => { setSearchQuery(event.target.value); setMarketplaceOffset(0) }} placeholder={filter === 'mcp' ? (isZh ? '搜索 MCP 名称、用途或作者' : 'Search MCP names, uses, or authors') : (isZh ? '搜索 Skills 名称或主题' : 'Search skills or topics')} /><select className={css.select} value={marketplaceCategory} onChange={(event) => { setMarketplaceCategory(event.target.value); setMarketplaceOffset(0) }}><option value="">{isZh ? '全部分类' : 'All categories'}</option>{marketplace?.categories.map(category => <option key={category.id} value={category.id}>{localizeCategory(category.label, language)}{category.count === undefined ? '' : ` (${category.count.toLocaleString()})`}</option>)}</select></div>
      {marketplaceLoading ? <p className={css.loading}>{isZh ? '正在读取社区目录…' : 'Loading community directory…'}</p> : null}
      {!marketplaceLoading && marketplaceError !== undefined ? <div className={css.alert} role="alert">{text.marketError}{marketplaceError}</div> : null}
      {capabilityError === undefined ? null : <div className={css.alert} role="alert">{text.capabilityError}{capabilityError}</div>}
      {!marketplaceLoading && marketplaceError === undefined && marketplace !== undefined && marketplace.items.length === 0 ? <div className={css.emptyCapability}><strong>{isZh ? '没有找到匹配条目' : 'No matching entries'}</strong><small>{isZh ? '修改搜索词或选择其他分类后重试。' : 'Change the search or select another category.'}</small></div> : null}
      <div className={css.marketplaceGrid}>{marketplace?.items.map((item, index) => <article className={css.capabilityCommunityCard} key={item.id}><div className={css.capabilityCommunityTop}><div className={css.marketplaceIdentity}><CapabilityIcon item={item} /><span className={css.capabilityCommunityKind}>{item.kind === 'mcp' ? 'MCP' : 'SKILL'}</span></div><span className={`${css.badge} ${item.installed ? css.badgeLive : ''}`}>{item.installed ? (isZh ? '已添加' : 'Added') : `#${(marketplace.offset + index + 1).toLocaleString()}`}</span></div><strong>{item.title}</strong><p>{item.description}</p><small>{item.author ?? localizeCategory(item.category, language)} · {item.kind === 'mcp' ? '★' : '↓'} {item.popularity.toLocaleString()}</small><div className={css.accountActions}><button className={css.marketplaceLink} type="button" onClick={() => { setSelectedCapability(item) }}>{capabilityText(language).details}</button><button className={`${css.button} ${css.buttonPrimary}`} type="button" disabled={item.installed || !item.installable || capabilityBusy !== undefined} onClick={() => { void installCapability(item) }}>{capabilityBusy === item.id ? (isZh ? '添加中…' : 'Adding…') : item.installed ? (isZh ? '已添加' : 'Added') : item.installable ? (isZh ? '一键添加' : 'Add') : (isZh ? '需手动配置' : 'Manual setup')}</button></div></article>)}</div>
      {marketplace !== undefined && marketplace.total > marketplace.limit ? <div className={css.marketplacePagination}><button className={css.button} type="button" disabled={marketplaceLoading || marketplace.offset === 0} onClick={() => { setMarketplaceOffset(current => Math.max(0, current - marketplace.limit)) }}>{isZh ? '上一页' : 'Previous'}</button><span>{isZh ? '第' : 'Page '} {Math.floor(marketplace.offset / marketplace.limit) + 1} / {Math.max(1, Math.ceil(marketplace.total / marketplace.limit))}</span><button className={css.button} type="button" disabled={marketplaceLoading || marketplace.offset + marketplace.items.length >= marketplace.total} onClick={() => { setMarketplaceOffset(current => current + marketplace.limit) }}>{isZh ? '下一页' : 'Next'}</button></div> : null}
    </section>}
    {state.environmentReady === false ? <div className={css.communityRestart}><span>{text.noPnpm}</span></div> : null}
    {state.error !== undefined ? <div className={css.alert} role="alert">{text.marketError}{state.error}</div> : null}
    {state.loading ? <p className={css.loading}>{text.loading}</p> : null}
    {state.restartNeeded ? <div className={css.communityRestart}><span>{text.restartNotice}</span><button className={`${css.button} ${css.buttonPrimary}`} type="button" onClick={restart} disabled={state.busyUrl !== undefined}>{text.restartNow}</button></div> : null}
    {!state.loading && state.error === undefined && pluginView === 'market' && state.plugins.length === 0 ? <p className={css.sectionMeta}>{text.emptyMarket}</p> : null}
    {!state.loading && state.error === undefined && filter === 'plugin' && pluginView === 'installed' && visiblePlugins.length === 0 ? <p className={css.sectionMeta}>{text.emptyInstalled}</p> : null}
    {filter === 'plugin' ? <div className={css.communityGrid}>
      {visiblePlugins.map((plugin) => {
        const name = installedName(plugin, state.installed, state.installedSources)
        const activation = name === undefined ? undefined : state.activation[name]
        const terminal = isTerminalPlugin(plugin)
        const busy = state.busyUrl === plugin.url
        const description = localizedPluginDescription(plugin, language)
        const iconUrl = state.iconUrls[plugin.url] ?? plugin.iconUrl ?? plugin.screenshots?.[0]
        return <article className={css.communityCard} key={plugin.url} role="button" tabIndex={0} aria-haspopup="dialog" onClick={() => { setSelectedPlugin(plugin) }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedPlugin(plugin) } }}>
          <div className={css.communityCardTop}><PluginIcon plugin={plugin} iconUrl={iconUrl} /><div className={css.communityIdentity}><strong>{plugin.name}</strong><small>{plugin.owner}</small></div><span className={css.communityCategory}>{localizeCategory(categories(plugin)[0] ?? 'plugin', language)}</span></div>
          <p className={css.communityDescription}>{description}</p>
          {plugin.featureNames !== undefined && plugin.featureNames.length > 0 ? <small className={css.communityFeatures}>{text.featureCount(plugin.featureNames.length + 1)}</small> : null}
          <div className={css.communityStats}><span>★ {formatCount(plugin.stars)}</span><span>↓ {formatCount(plugin.downloads)}</span></div>
          {activation?.state !== undefined ? <div className={css.communityState}>{activationLabel(activation.state, language)}</div> : null}
          {terminal ? <div className={css.communityIncompatible}>{text.terminalOnly}</div> : <button className={`${css.button} ${name === undefined ? css.buttonPrimary : css.buttonDanger} ${css.communityInstall}`} type="button" onClick={(event) => { event.stopPropagation(); if (name === undefined) void install(plugin); else void uninstall(plugin) }} disabled={busy || state.busyUrl !== undefined || state.environmentReady === false || (name !== undefined && communityUninstall === undefined)}>{busy ? `${state.phase === 'uninstalling' ? text.uninstalling : text.installing}${state.currentPackage === undefined ? '' : ` · ${state.currentPackage}`}` : name === undefined ? text.install : text.uninstall}</button>}
          {busy && state.seconds !== undefined ? <small className={css.communityProgress}>{state.seconds}s · {state.phase ?? 'working'}</small> : null}
        </article>
      })}
    </div> : null}
    {filter === 'plugin' ? <small className={css.communityFootnote}>{pluginView === 'installed' ? text.installedCount(visiblePlugins.length) : searchQuery.trim() === '' ? <>{text.marketCount(visiblePlugins.length)}{state.marketTotal > state.plugins.length ? text.marketTruncated(state.marketTotal, state.plugins.length) : ''}</> : text.searchCount(visiblePlugins.length)}{text.usableCount(visibleReadyCount)}</small> : null}
    {selectedCapability === undefined ? null : <CapabilityDetailModal item={selectedCapability as CapabilityDetailItem} language={language} busy={capabilityBusy === selectedCapability.id} onClose={() => { setSelectedCapability(undefined) }} onInstall={selectedCapability.installable && !selectedCapability.installed ? () => { void installCapability(selectedCapability) } : undefined} />}
    {selectedPlugin !== undefined ? <div className={css.communityModalBackdrop} role="presentation" onClick={() => { setSelectedPlugin(undefined) }}><article className={css.communityModal} role="dialog" aria-modal="true" aria-label={selectedPlugin.name} tabIndex={-1} onClick={(event) => { event.stopPropagation() }}><header className={css.communityModalHeader}><div><div className={css.kicker}>PLUGIN DETAILS</div><PluginIcon plugin={selectedPlugin} iconUrl={state.iconUrls[selectedPlugin.url] ?? selectedPlugin.iconUrl ?? selectedPlugin.screenshots?.[0]} /><h3 className={css.communityModalTitle}>{selectedPlugin.name}</h3><small className={css.communityModalOwner}>{selectedPlugin.owner} · {localizeCategory(categories(selectedPlugin)[0] ?? 'plugin', language)}</small></div><button ref={modalCloseRef} className={css.button} type="button" onClick={() => { setSelectedPlugin(undefined) }}>{text.close}</button></header><p className={css.communityModalSummary}>{localizedPluginDescription(selectedPlugin, language)}</p>{isZh && !pluginDescriptionLocalized(selectedPlugin, language) ? <p className={css.sectionMeta}>{upstreamEnglishHint('zh')}</p> : null}{selectedPlugin.featureNames !== undefined && selectedPlugin.featureNames.length > 0 ? <div className={css.communityFeatureList}>{text.modalFeatureCount}{selectedPlugin.featureNames.join('、')}</div> : null}<div className={css.communityModalStats}><span>★ {formatCount(selectedPlugin.stars)}</span><span>↓ {formatCount(selectedPlugin.downloads)}</span><a href={`${selectedPlugin.url}#readme`} target="_blank" rel="noreferrer">{text.openProject}</a></div><div className={css.communityReadme}>{readme.loading ? <p className={css.loading}>{text.readmeLoading}</p> : readme.text !== undefined ? <>{isZh && readme.localized ? <p className={css.sectionMeta}>{text.readmeChinese}</p> : null}<pre>{readme.text}</pre></> : <p className={css.sectionMeta}>{readme.error === 'unreadable' ? text.readmeError : text.readmeEmpty}</p>}</div><footer className={css.communityModalFooter}>{isTerminalPlugin(selectedPlugin) ? <span className={css.communityIncompatible}>{text.terminalOnly}</span> : (() => { const name = installedName(selectedPlugin, state.installed, state.installedSources); return <button className={`${css.button} ${name === undefined ? css.buttonPrimary : css.buttonDanger}`} type="button" onClick={() => { if (name === undefined) void install(selectedPlugin); else void uninstall(selectedPlugin); setSelectedPlugin(undefined) }} disabled={state.busyUrl !== undefined || state.environmentReady === false || (name !== undefined && communityUninstall === undefined)}>{name === undefined ? text.install : text.uninstall}</button> })()}</footer></article></div> : null}
  </section>
}
