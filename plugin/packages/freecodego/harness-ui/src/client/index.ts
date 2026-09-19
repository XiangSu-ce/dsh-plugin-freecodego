import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { useSyncExternalStore } from 'react'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-freecodego-harness-plugin/remote'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
import type { AgnesStatus, ClineDeviceLogin, ClineLoginPoll, ClineStatus, DeferredToolStatus, TeamRuntimeStatus, FreeCodeGoAutomationSettings, FreeCodeGoBackendSnapshot, FreeCodeGoAutomationSettingsUpdate, FreeCodeGoVyceStatus, FreeCodeGoDeviceSessions, FreeCodeGoEngineeringEvalReport, FreeCodeGoEngineeringMemoryRecall, FreeCodeGoEngineeringSkillDraftResult, FreeCodeGoEngineeringSpecBundle, FreeCodeGoEngineId, FreeCodeGoGuardSettingsStatus, FreeCodeGoGuardSettingsUpdate, FreeCodeGoSandboxMode, FreeCodeGoSandboxStatus, FreeCodeGoTrustStatus, FreeCodeGoLogfareRegistrationRequest, FreeCodeGoLogfareStatus, FreeCodeGoNvidiaStatus, FreeCodeGoPluginConflictStatus, FreeCodeGoSenseNovaStatus, FreeCodeGoSkillDetail, HeadroomStats, WorkBuddyBrowserLogin, WorkBuddyInternationalStatus, WorkBuddyLoginPoll, MemoryConsolidation, MemoryManifest, ProjectConfigReport } from '@deepseek-ai/dsh-freecodego-harness-plugin'
import type { AdvisorSnapshot, AdvisorUpdate, EngineeringMemoryIndex } from './settings-tab.tsx'
import freeCodeGoRemote from '@deepseek-ai/dsh-freecodego-harness-plugin/remote'
import { ADVISOR_CHANGE_EVENT, CAPABILITY_CHANGE_EVENT, ENGINEERING_CHANGE_EVENT, AdvisorSettingsSection, EngineeringSettingsSection, FreeCodeGoSettingsSection, McpSettingsSection, PluginConflictNotice, SkillSettingsSection, type EngineeringLoopStatus, type EngineeringSettings, type EngineeringStatus, type EngineeringTeamDecision, type EngineeringTeamImplementation, type EngineeringTeamJob, type EngineeringTeamReport, type EngineeringTeamVerification } from './settings-tab.tsx'
import { SessionDeleteOverlay } from './session-delete-overlay.tsx'
import { EngineAction, EngineExecutionBadge, LanguageAction, VoiceInputAction } from './toolbar-actions.tsx'
import { installFreeCodeGoSidebarIcons } from './sidebar-icons.ts'
import { installCompanion } from './companion/companion.tsx'
import { installNativeModelMenuBadges, type NativeModelDirectorySnapshot } from './native-model-menu-badges.ts'
import { installModelSelectionEcho } from './model-selection-echo.ts'
import { installModelCatalogRetry } from './model-catalog-retry.ts'
import { TokenUsageDashboard } from './token-usage-dashboard.tsx'
import { installGeneratedMediaToolviews } from './generated-media-toolview.tsx'
import { mainViewSessionId } from './current-session.ts'
import { registerAgentProgressUi } from './agent-progress.tsx'
import './theme.css'

const NS = 'settings.freecodego'
type ManagedCatalog = { readonly catalogRevision: string; readonly groups?: readonly { readonly id: number; readonly name: string; readonly enabled: boolean; readonly default?: boolean; readonly rateMultiplier?: number; readonly sortOrder?: number }[]; readonly models: readonly { readonly id: string; readonly displayName: string; readonly provider: string; readonly protocol: string; readonly availability: string; readonly compatibleEngines: readonly FreeCodeGoEngineId[]; readonly choices: readonly { readonly routeKey: string; readonly label: string; readonly availability: string; readonly compatibleEngines: readonly FreeCodeGoEngineId[]; readonly zeroPrice?: boolean; readonly locked?: boolean; readonly rateMultiplier?: number; readonly groupName?: string; readonly groupId?: number; readonly protocol?: string; readonly access?: string; readonly unlockRequired?: boolean; readonly unlockReason?: string; readonly unlockExpiresAt?: string }[] }[] }
type CapabilitySnapshot = { readonly mcpEnabled: boolean; readonly skillEnabled: boolean; readonly voiceInputEnabled: boolean; readonly sessionDeleteEnabled: boolean; readonly modelCategories: Readonly<Record<string, 'text' | 'image' | 'video' | 'audio'>>; readonly mcpServers: readonly { readonly id: string; readonly enabled: boolean; readonly transport: 'stdio' | 'streamable-http'; readonly serverName: string; readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly cwd: string; readonly url: string; readonly headers: Readonly<Record<string, string>> }[]; readonly skillRoots: readonly { readonly id: string; readonly enabled: boolean; readonly path: string }[]; readonly skillInvocationOverrides?: Readonly<Record<string, boolean>> | undefined; readonly mcpTools: readonly { readonly name: string; readonly description: string }[]; readonly skills: readonly { readonly name: string; readonly description: string; readonly source: string; readonly modelInvocable: boolean; readonly userInvocable: boolean }[] }
type CapabilityMarketplacePage = { readonly kind: 'mcp' | 'skill'; readonly total: number; readonly offset: number; readonly limit: number; readonly query?: string; readonly categories: readonly { readonly id: string; readonly label: string; readonly count?: number }[]; readonly items: readonly { readonly id: string; readonly kind: 'mcp' | 'skill'; readonly title: string; readonly description: string; readonly category: string; readonly sourceUrl: string; readonly iconUrl?: string; readonly author?: string; readonly popularity: number; readonly installed: boolean; readonly installable: boolean; readonly requiresConfiguration?: boolean }[] }
// `AdvisorSnapshot` / `AdvisorUpdate` used to be declared here as well as in
// settings-tab.tsx, and the copies had already drifted: this one was missing
// `sideChannelWarnings`, which the Advisor section renders. The panel kept
// working only because TypeScript types do not strip runtime fields. One
// definition now, imported from the module that consumes it.
type AdvisorModelChoice = { readonly id: string; readonly displayName: string; readonly provider: string; readonly description: string }
type AdvisorNote = { readonly id: string; readonly sessionId: string; readonly turn: number; readonly severity: 'nit' | 'concern' | 'blocker'; readonly note: string; readonly delivery: 'record' | 'inject' | 'steer'; readonly time: number }
type GatewayModelPrice = { readonly modelId: string; readonly displayName: string; readonly provider: string; readonly source: 'gateway' | 'vyce' | 'empero' | 'opencode' | 'openrouter' | 'logfare' | 'workbuddy' | 'agnes' | 'sensenova' | 'nvidia'; readonly groupName: string; readonly platform?: string; readonly rateMultiplier: number; readonly billingMode: 'token' | 'per-request' | 'image'; readonly currency: string; readonly description?: string; readonly originalInputPricePerMillion?: number; readonly originalOutputPricePerMillion?: number; readonly originalCacheReadPricePerMillion?: number; readonly originalCacheWritePricePerMillion?: number; readonly originalPerRequestPrice?: number; readonly originalImageOutputPricePerMillion?: number; readonly inputPricePerMillion?: number; readonly outputPricePerMillion?: number; readonly cacheReadPricePerMillion?: number; readonly cacheWritePricePerMillion?: number; readonly perRequestPrice?: number; readonly imageOutputPricePerMillion?: number; readonly imagePrices?: readonly { readonly label: string; readonly price: number; readonly originalPrice?: number }[] }

// Function-typed properties, not methods: `useSyncExternalStore` is handed
// `subscribe` and `getSnapshot` as bare references, and this declares that the
// store really is safe to call that way.
interface EpochStore {
  readonly getSnapshot: () => number
  readonly increment: () => void
  readonly subscribe: (listener: () => void) => () => void
}

/** Keep this UI's reconnect state local so it has no hidden client-runtime dependency. */
function createEpochStore(): EpochStore {
  let value = 0
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    increment: () => {
      value += 1
      for (const listener of [...listeners]) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

function useEpochSelector(store: EpochStore): SnapshotSelectorHook<number> {
  return selector => selector(useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot))
}

// Alpha.1 enforces injected Context service access. The settings section reads
// the current session for engineering and model controls, so `sessions` must
// be declared at the root rather than accessed through an undeclared context.
export const inject = ['slots', 'locale', 'remote', 'connection', 'sessions', 'uiConversation']

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.freecodego': string
  }
}

// Exported alongside `en`, not merely used by the `locale.register` call below:
// the locale-dictionary parity gate discovers module-scope *exported*
// dictionaries, so a private `zh` paired with an exported `en` left both sides
// unchecked. Exporting it brings the pair under the gate.
export const zh = {
  tab: 'FreeCodeGo',
  'language.switch': '切换中英文',
  engineShort: '引擎',
  engineHint: '选择新会话使用的 Agent 引擎',
  engineNative: '原生 Thinking',
  engineAdapter: '适配器 Reasoning',
  engineExecutionHint: '会话已固定的 Agent 引擎与实际执行器：',
  engineSwitchTitle: '当前会话引擎已固定',
  engineSwitchHint: '切换仅对新对话生效，请新建对话后使用新引擎。',
  engineSwitchDismiss: '关闭引擎切换提示',
  engineSwitchFailed: '引擎切换失败，请稍后重试。',
  engineCatalogFailed: '引擎列表读取失败，Codex/Claude 暂时无法选择。',
  engineRetry: '重试',
  engineDeepseek: 'DeepSeek',
  engineCodex: 'Codex',
  engineClaude: 'Claude',
  engineering: '工程增强',
  title: 'FreeCodeGo Agent',
  eyebrow: 'FREECODEGO CONTROL DECK',
  heroDescription: '统一管理模型路由、账户授权与实时额度。支持 FreeCodeGo 网关、OpenCode 与 Agnes。',
  runtime: '运行环境',
  modelRouting: '模型路由',
  provider: '服务提供方',
  live: '运行中',
  connectedAccount: '账户已连接',
  notSignedIn: '尚未登录',
  signedOut: '未连接',
  refresh: '刷新引擎状态',
  loading: '正在读取引擎状态…',
  error: '无法读取 FreeCodeGo 引擎状态。',
  available: '可用',
  unavailable: '不可用',
  leases: '活动会话',
  generation: '代次',
  account: '账户',
  recharge: '充值与套餐',
  openFreeCodeGoBilling: 'FreeCodeGo 实时套餐',
  backendRequired: 'FreeCodeGo 服务尚未启动或尚未登录，登录后即可查看套餐并充值。',
  defaultModel: '新会话默认模型',
  email: '邮箱',
  password: '密码',
  rememberLogin: '保持登录状态（重启后不用重新登录）',
  login: '登录',
  logout: '退出登录',
  mfa: '需要双重验证：',
  active: '已启用',
  inactive: '未启用',
  backendNotConfigured: 'FreeCodeGo 服务暂时不可用，请稍后重试或联系部署管理员。',
  bootstrap: '模型引导',
  quota: '配额',
  health: '运行时健康',
  usage: '使用量',
  accountDetail: '账户详情',
  connected: '已连接',
  disconnected: '未连接',
  plans: '套餐',
  purchasePlans: '购买方案',
  subscriptionTitle: '选择你的开发额度',
  subscriptionHint: '按需购买，余额永久保留并可叠加使用。',
  balance: '余额',
  noPlans: '当前没有可售套餐，已保留真实接口返回的空状态。',
  planSyncPending: '该档位等待支付服务同步',
  pendingOrders: '待支付订单',
  pendingOrdersHint: '账户已有未完成订单，先取消遗留订单后再创建新的充值订单。',
  recommended: '推荐',
  balanceForever: '余额永久保留，可叠加充值',
  paymentMethod: '支付方式',
  checkout: '购买',
  processing: '处理中…',
  order: '订单',
  refreshOrder: '刷新订单',
  openCheckout: '打开支付页',
  paymentQr: '支付二维码',
  stripeSessionReady: 'Stripe 支付会话已创建，请在支付页完成付款。',
  verifyOrder: '校验订单',
  cancelOrder: '取消订单',
  emailReceipt: '发送收据到邮箱',
  register: '注册',
  verifyCode: '验证码',
  sendVerifyCode: '发送验证码',
  totpCode: '双重验证码',
  completeMfa: '完成验证',
  cloudRuntime: '云端运行时',
  engineLabel: 'Agent 引擎',
  engineNewSessionOnly: '仅新会话生效',
  codexAgent: 'Codex Agent',
  installed: '已安装',
  optionalComponent: '可选组件',
  installCodex: '安装 Codex',
  installClaude: '安装 Claude',
  installing: '安装中…',
  remove: '移除',
  communityFeedback: '社区与反馈',
  telegramGroup: 'Telegram 官方群聊',
  telegramHint: '遇到问题需要反馈，或想跟进版本进展，点击加入官方群聊。',
  telegramJoin: '加入群聊',
} as const

export const en = {
  tab: 'FreeCodeGo',
  'language.switch': 'Switch language',
  engineShort: 'Engine',
  engineHint: 'Choose the Agent engine for new sessions',
  engineNative: 'Native Thinking',
  engineAdapter: 'Adapter Reasoning',
  engineExecutionHint: 'Session-pinned Agent engine and executor:',
  engineSwitchTitle: 'Current session engine is fixed',
  engineSwitchHint: 'This change applies only to new sessions. Start a new conversation to use it.',
  engineSwitchDismiss: 'Dismiss engine switch notice',
  engineSwitchFailed: 'The engine switch failed. Try again shortly.',
  engineCatalogFailed: 'The engine list could not be loaded, so Codex/Claude cannot be selected yet.',
  engineRetry: 'Retry',
  engineDeepseek: 'DeepSeek',
  engineCodex: 'Codex',
  engineClaude: 'Claude',
  engineering: 'Engineering',
  title: 'FreeCodeGo Agent',
  eyebrow: 'FREECODEGO CONTROL DECK',
  heroDescription: 'Manage model routing, account authorization, and live credits across FreeCodeGo, OpenCode, and Agnes.',
  runtime: 'Runtime',
  modelRouting: 'Model routing',
  provider: 'Provider',
  live: 'Live',
  connectedAccount: 'Account connected',
  notSignedIn: 'Not signed in',
  signedOut: 'Offline',
  refresh: 'Refresh engine status',
  loading: 'Reading engine status…',
  error: 'FreeCodeGo engine status is unavailable.',
  available: 'Available',
  unavailable: 'Unavailable',
  leases: 'Active sessions',
  generation: 'Generation',
  account: 'Account',
  recharge: 'Billing and plans',
  openFreeCodeGoBilling: 'Live FreeCodeGo plans',
  backendRequired: 'FreeCodeGo is not running or you are not signed in. Sign in to view plans and recharge.',
  defaultModel: 'New-session model',
  email: 'Email',
  password: 'Password',
  rememberLogin: 'Keep me signed in (no re-login after restart)',
  login: 'Sign in',
  logout: 'Sign out',
  mfa: 'Two-factor authentication is required:',
  active: 'active',
  inactive: 'inactive',
  backendNotConfigured: 'FreeCodeGo is temporarily unavailable. Retry or contact the deployment administrator.',
  bootstrap: 'Bootstrap',
  quota: 'Quota',
  health: 'Runtime health',
  usage: 'Usage',
  accountDetail: 'Account details',
  connected: 'connected',
  disconnected: 'disconnected',
  plans: 'plans',
  purchasePlans: 'Purchase plans',
  subscriptionTitle: 'Choose your developer allowance',
  subscriptionHint: 'Buy only what you need. Balance never expires and stacks.',
  balance: 'Balance',
  noPlans: 'No plans are currently available for sale. The live backend returned an empty catalog.',
  planSyncPending: 'Awaiting payment-service sync for this tier',
  pendingOrders: 'Pending payment orders',
  pendingOrdersHint: 'This account has unfinished orders. Cancel stale orders before creating another recharge order.',
  recommended: 'Recommended',
  balanceForever: 'Balance never expires and stacks with future recharges',
  paymentMethod: 'Payment method',
  checkout: 'Checkout',
  processing: 'Processing…',
  order: 'Order',
  refreshOrder: 'Refresh order',
  openCheckout: 'Open checkout',
  paymentQr: 'Payment QR code',
  stripeSessionReady: 'Stripe payment session created; finish payment in the checkout page.',
  verifyOrder: 'Verify order',
  cancelOrder: 'Cancel order',
  emailReceipt: 'Email receipt',
  register: 'Register',
  verifyCode: 'Verification code',
  sendVerifyCode: 'Send verification code',
  totpCode: 'Two-factor code',
  completeMfa: 'Complete verification',
  cloudRuntime: 'Cloud runtime',
  engineLabel: 'Agent engine',
  engineNewSessionOnly: 'Only new sessions use this engine.',
  codexAgent: 'Codex Agent',
  installed: 'Installed',
  optionalComponent: 'Optional component',
  installCodex: 'Install Codex',
  installClaude: 'Install Claude',
  installing: 'Installing…',
  remove: 'Remove',
  communityFeedback: 'Community and feedback',
  telegramGroup: 'Official Telegram group',
  telegramHint: 'Report a problem or follow release progress by joining the official group.',
  telegramJoin: 'Join the group',
} satisfies Record<keyof typeof zh, string>

export function apply(ctx: ClientContext): void {
  ctx.effect(() => installFreeCodeGoSidebarIcons(), 'freecodego-ui: semantic sidebar icons')
  // The agent's face in the sidebar rail: an animated mark driven by session
  // activity. It shadows the brand slot's default occupant, so it needs the
  // slot ledger and nothing else from the shell.
  installCompanion(ctx)
  registerAgentProgressUi(ctx)
  // The core Tool package only owns a specialized read_image card. Register
  // FreeCodeGo media tool views here so generated attachments render inline
  // without requiring a Harness core UI upgrade.
  installGeneratedMediaToolviews(ctx)
  // Mark the composed client synchronously so the stock DeepSeek first-run
  // dialog can never gate a FreeCodeGo installation on DEEPSEEK_API_KEY.
  ;(globalThis as typeof globalThis & { __DSH_FREECODEGO_ACTIVE__?: boolean }).__DSH_FREECODEGO_ACTIVE__ = true
  // dsh-market still provides the Host installer/registry routes, while its
  // full navigation is embedded in the FreeCodeGo settings tab below.
  ;(globalThis as typeof globalThis & { __DSH_FREECODEGO_EMBEDDED_MARKET__?: boolean }).__DSH_FREECODEGO_EMBEDDED_MARKET__ = true
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'freecodego-ui: dictionaries')
  const t = ctx.locale.bind(NS)
  const settingsLanguage = (): 'zh' | 'en' => ctx.locale.getLocale().active === 'zh' ? 'zh' : 'en'
  const readFreeCodeGoSettings = async (): Promise<Record<string, unknown>> => {
    const settings = ctx.get('remote.settings') as {
      describe?: () => Promise<RemoteResult<{ readonly namespaces: readonly { readonly ns: string; readonly value: unknown }[] }>>
      update?: (namespace: string, patch: Record<string, JsonValue>, expectedRevision: undefined) => Promise<RemoteResult<unknown>>
    } | undefined
    if (typeof settings?.describe !== 'function') throw new Error('Harness settings Remote service did not become available')
    const response = await settings.describe()
    if (!response.ok) throw new Error(response.error.message)
    const value = response.value.namespaces.find(item => item.ns === 'freecodego-harness')?.value
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  }
  const updateFreeCodeGoSettings = async (patch: Record<string, unknown>): Promise<void> => {
    const settings = ctx.get('remote.settings') as {
      update?: (namespace: string, patch: Record<string, JsonValue>, expectedRevision: undefined) => Promise<RemoteResult<unknown>>
    } | undefined
    if (typeof settings?.update !== 'function') throw new Error('Harness settings Remote service did not become available')
    const response = await settings.update('freecodego-harness', patch as Record<string, JsonValue>, undefined)
    if (!response.ok) throw new Error(response.error.message)
  }
  const connectionEpoch = createEpochStore()
  const useConnectionEpoch = useEpochSelector(connectionEpoch)
  ctx.on('connection/reset', () => { connectionEpoch.increment() })
  const modelAvailability = new Map<string, { readonly available: boolean; readonly reason?: string }>()

  // Start mounting without blocking client bootstrap. Remote readiness depends
  // on that bootstrap completing, so awaiting here would deadlock a fresh page.
  const remoteMounted = ctx.remote.$mount(freeCodeGoRemote)
  const catalog = async (): ReturnType<typeof ctx.remote.freeCodeGoHarness.catalog> => {
    await remoteMounted
    // Dynamic plugins may query an optional service through ctx.get(). Direct
    // property access is intentionally restricted to static inject entries;
    // declaring this namespace there would deadlock its own Remote mount.
    const service = ctx.get('remote.freeCodeGoHarness') as {
      catalog?: () => ReturnType<typeof ctx.remote.freeCodeGoHarness.catalog>
    } | undefined
    if (typeof service?.catalog !== 'function') {
      throw new Error('FreeCodeGo Remote catalog service did not become available')
    }
    return service.catalog()
  }
  ctx.effect(() => installNativeModelMenuBadges({
    language: settingsLanguage,
    availability: () => modelAvailability,
    snapshot: () => {
      const directories = ctx.get('modelDirectories') as {
        directoryFor?: (sessionId: string) => {
          readonly store?: { getSnapshot?: () => NativeModelDirectorySnapshot & { readonly status?: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'; readonly error?: string | null }; subscribe?: (listener: () => void) => () => void; update?: (mutator: (state: { current: unknown; routable: boolean | null; status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'; error: string | null }) => void) => void }
          select?: (selection: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }) => Promise<void>
          load?: () => Promise<unknown>
        }
      } | undefined
      const sessionId = mainViewSessionId(ctx)
      if (sessionId === undefined || typeof directories?.directoryFor !== 'function') return undefined
      const directory = directories.directoryFor(sessionId)
      if (typeof directory.select === 'function' && directory.store?.update !== undefined) installModelSelectionEcho(directory as Parameters<typeof installModelSelectionEcho>[0])
      if (typeof directory.load === 'function' && typeof directory.store?.getSnapshot === 'function' && typeof directory.store.subscribe === 'function') installModelCatalogRetry(directory as Parameters<typeof installModelCatalogRetry>[0])
      return directory.store?.getSnapshot?.()
    },
  }), 'freecodego-ui: native model-menu metadata badges')
  type Account = { status: 'signed-out' | 'mfa-required' | 'authenticated' | 'reauth-required' | 'backend-not-configured'; emailMasked?: string; user?: { username: string; email: string; avatarUrl?: string; balance: number } }
  const accountStatus = async (): Promise<RemoteResult<Account>> => {
    await remoteMounted
    const service = ctx.get('remote.freeCodeGoHarness') as { accountStatus?: () => Promise<RemoteResult<Account>> } | undefined
    if (typeof service?.accountStatus !== 'function') throw new Error('FreeCodeGo account Remote service did not become available')
    return service.accountStatus()
  }
  const login = async (email: string, password: string, remember?: boolean): Promise<RemoteResult<Account>> => {
    await remoteMounted
    const service = ctx.get('remote.freeCodeGoHarness') as { accountLogin?: (input: { email: string; password: string; remember?: boolean }) => Promise<RemoteResult<Account>> } | undefined
    if (typeof service?.accountLogin !== 'function') throw new Error('FreeCodeGo login Remote service did not become available')
    // `remember` rides the same login call: unchecked means the Host keeps the
    // issued session in memory for this run instead of the credential file.
    return service.accountLogin({ email, password, ...(remember === undefined ? {} : { remember }) })
  }
  const logout = async (): Promise<RemoteResult<Account>> => {
    await remoteMounted
    const service = ctx.get('remote.freeCodeGoHarness') as { accountLogout?: () => Promise<RemoteResult<Account>> } | undefined
    if (typeof service?.accountLogout !== 'function') throw new Error('FreeCodeGo logout Remote service did not become available')
    return service.accountLogout()
  }
  const register = async (input: { email: string; password: string; verifyCode?: string }): Promise<RemoteResult<Account>> => {
    await remoteMounted
    const service = ctx.get('remote.freeCodeGoHarness') as { accountRegister?: (input: { email: string; password: string; verifyCode?: string }) => Promise<RemoteResult<Account>> } | undefined
    if (typeof service?.accountRegister !== 'function') throw new Error('FreeCodeGo registration Remote service did not become available')
    return service.accountRegister(input)
  }
  const sendVerifyCode = async (email: string): Promise<RemoteResult<{ countdown: number }>> => {
    await remoteMounted
    const service = ctx.get('remote.freeCodeGoHarness') as { accountSendVerifyCode?: (email: string) => Promise<RemoteResult<{ countdown: number }>> } | undefined
    if (typeof service?.accountSendVerifyCode !== 'function') throw new Error('FreeCodeGo verification Remote service did not become available')
    return service.accountSendVerifyCode(email)
  }
  /**
   * Federated sign-in (Google / GitHub). The Host does not expose an OAuth
   * entry point yet, so this reports the missing wire with a stable marker
   * instead of a generic "service did not become available" — the card turns
   * that into an in-place notice. Adding `accountOAuthLogin` to the Host is the
   * only change needed to make the buttons real; the UI path stays the same.
   */
  const oauthLogin = async (provider: 'google' | 'github'): Promise<RemoteResult<Account>> => {
    await remoteMounted
    const service = ctx.get('remote.freeCodeGoHarness') as { accountOAuthLogin?: (provider: 'google' | 'github') => Promise<RemoteResult<Account>> } | undefined
    if (typeof service?.accountOAuthLogin !== 'function') throw new Error(`OAUTH_NOT_WIRED:${provider}`)
    return service.accountOAuthLogin(provider)
  }
  /** Read the pending federated registration the browser step left behind. */
  const oauthPendingStatus = (): Promise<RemoteResult<Record<string, unknown>>> => backendCall<Record<string, unknown>>('accountOAuthPendingStatus')
  /** Send the registration verification email for the pending session. */
  const oauthPendingSendVerifyCode = (email: string): Promise<RemoteResult<{ readonly countdown: number }>> => backendCall<{ readonly countdown: number }>('accountOAuthPendingSendVerifyCode', email)
  /** Bind the pending federated identity to an existing password account. */
  const oauthPendingBind = (input: { readonly email: string; readonly password: string; readonly totpCode?: string }): Promise<RemoteResult<Account>> => backendCall<Account>('accountOAuthPendingBind', input)
  /** Create a new account from the pending federated identity. */
  const oauthPendingCreate = (input: { readonly email: string; readonly password: string; readonly verifyCode?: string; readonly invitationCode?: string }): Promise<RemoteResult<Account>> => backendCall<Account>('accountOAuthPendingCreate', input)
  const completeMfa = async (totpCode: string): Promise<RemoteResult<Account>> => {
    await remoteMounted
    const service = ctx.get('remote.freeCodeGoHarness') as { accountMfaComplete?: (totpCode: string) => Promise<RemoteResult<Account>> } | undefined
    if (typeof service?.accountMfaComplete !== 'function') throw new Error('FreeCodeGo MFA Remote service did not become available')
    return service.accountMfaComplete(totpCode)
  }
  const backendCall = async <T>(method: string, ...args: readonly unknown[]): Promise<RemoteResult<T>> => {
    await remoteMounted
    // The Host registers its Remote surface asynchronously after a harness
    // restart/plugin reload; calls racing that window used to fail hard with
    // `method "…" did not become available` and only a manual refresh healed
    // them. Poll briefly for the method instead — bounded, so a genuinely
    // missing method still errors out fast.
    const deadline = Date.now() + 8_000
    for (;;) {
      const service = ctx.get('remote.freeCodeGoHarness') as Record<string, unknown> | undefined
      const call = service?.[method]
      if (typeof call === 'function') return (call as (...input: readonly unknown[]) => Promise<RemoteResult<T>>)(...args)
      if (Date.now() > deadline) throw new Error(`FreeCodeGo Remote method "${method}" did not become available`)
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }
  const refreshModelAvailability = async (): Promise<void> => {
    try {
      const result = await backendCall<readonly { readonly provider: string; readonly model: string; readonly available: boolean; readonly reason?: string }[]>('modelAvailability')
      if (!result.ok) return
      modelAvailability.clear()
      for (const entry of result.value) modelAvailability.set(`${entry.provider}\u0000${entry.model}`, { available: entry.available, ...(entry.reason === undefined ? {} : { reason: entry.reason }) })
      document.dispatchEvent(new Event('fcg:model-availability-updated'))
    } catch {
      // The native selector remains usable from its last successful catalog.
    }
  }
  void refreshModelAvailability()
  const notifyModelCatalogChanged = (): void => { globalThis.dispatchEvent(new Event('fcg:model-catalog-updated')) }
  ctx.remote.$on('llm/adapters-updated', () => { void refreshModelAvailability(); notifyModelCatalogChanged() })
  ctx.remote.$on('settings/document-updated', notifyModelCatalogChanged)
  ctx.remote.$on('credentials/reference-updated', notifyModelCatalogChanged)

  // FreeCodeGo's provider readiness used to be pushed into the Models page
  // through a client extension point (`alternateProviderReadiness`) that the
  // plugin's own retired `ui-settings-models` package provided. Both sides are
  // gone: the page now derives routability Host-side from the adapter and
  // credential registrations this plugin already feeds, so there is nothing
  // left to register into.

  const engineCatalog = (): ReturnType<typeof catalog> => catalog()
  const setDefaultEngine = (engine: 'deepseek' | 'codex' | 'claude'): Promise<RemoteResult<{ readonly engine: 'deepseek' | 'codex' | 'claude' }>> => backendCall('setDefaultEngine', engine)
  const sessionEngineStatus = (sessionId: string): Promise<RemoteResult<{ readonly engine: string; readonly executor: 'native' | 'adapter-loop'; readonly provider: string; readonly model: string }>> => backendCall('sessionEngineStatus', sessionId)
  const capabilities = (): Promise<RemoteResult<CapabilitySnapshot>> => backendCall<CapabilitySnapshot>('capabilities')
  const pluginConflictStatus = (): Promise<RemoteResult<FreeCodeGoPluginConflictStatus>> => backendCall<FreeCodeGoPluginConflictStatus>('pluginConflictStatus')
  const pluginConflictSetEnabled = (enabled: boolean): Promise<RemoteResult<FreeCodeGoPluginConflictStatus>> => backendCall<FreeCodeGoPluginConflictStatus>('pluginConflictSetEnabled', enabled)
  const headroomStatus = (): Promise<RemoteResult<HeadroomStats>> => backendCall<HeadroomStats>('headroomStatus')
  const headroomSetEnabled = (enabled: boolean): Promise<RemoteResult<HeadroomStats>> => backendCall<HeadroomStats>('headroomSetEnabled', enabled)
  const headroomUpdate = (patch: { readonly thresholdChars?: number; readonly minSavingsRatio?: number; readonly dedupEnabled?: boolean; readonly excludeTools?: readonly string[]; readonly foldReads?: boolean; readonly codeSkeletonEnabled?: boolean }): Promise<RemoteResult<HeadroomStats>> => backendCall<HeadroomStats>('headroomUpdate', patch)
  const deferredToolsStatus = (): Promise<RemoteResult<DeferredToolStatus>> => backendCall<DeferredToolStatus>('deferredToolsStatus')
  const deferredToolsSetEnabled = (enabled: boolean): Promise<RemoteResult<DeferredToolStatus>> => backendCall<DeferredToolStatus>('deferredToolsSetEnabled', enabled)
  const teamStatus = (): Promise<RemoteResult<TeamRuntimeStatus>> => backendCall<TeamRuntimeStatus>('teamStatus')
  const guardSettingsStatus = (): Promise<RemoteResult<FreeCodeGoGuardSettingsStatus>> => backendCall<FreeCodeGoGuardSettingsStatus>('guardSettingsStatus')
  const guardSettingsUpdate = (patch: FreeCodeGoGuardSettingsUpdate): Promise<RemoteResult<FreeCodeGoGuardSettingsStatus>> => backendCall<FreeCodeGoGuardSettingsStatus>('guardSettingsUpdate', patch)
  const automationSettingsStatus = (): Promise<RemoteResult<FreeCodeGoAutomationSettings>> => backendCall<FreeCodeGoAutomationSettings>('automationSettingsStatus')
  const automationSettingsUpdate = (patch: FreeCodeGoAutomationSettingsUpdate): Promise<RemoteResult<FreeCodeGoAutomationSettings>> => backendCall<FreeCodeGoAutomationSettings>('automationSettingsUpdate', patch)
  const sandboxModeStatus = (sessionId: string): Promise<RemoteResult<FreeCodeGoSandboxStatus>> => backendCall<FreeCodeGoSandboxStatus>('sandboxModeStatus', sessionId)
  /**
   * Folder trust, as a panel sees it.
   *
   * The status call is deliberately argument-less: the Host answers about the
   * workspace it is running in, which is the question the panel is asking. Grant
   * and revoke are handed the canonical root that same answer reported, so the
   * panel never derives a repository root of its own — a second derivation is how
   * a revoke ends up naming a directory the grant never recorded.
   */
  const trustFolderStatus = (): Promise<RemoteResult<FreeCodeGoTrustStatus>> => backendCall<FreeCodeGoTrustStatus>('trustFolderStatus')
  const trustFolderGrant = (directory: string): Promise<RemoteResult<FreeCodeGoTrustStatus>> => backendCall<FreeCodeGoTrustStatus>('trustFolderGrant', directory)
  const trustFolderRevoke = (directory: string): Promise<RemoteResult<FreeCodeGoTrustStatus>> => backendCall<FreeCodeGoTrustStatus>('trustFolderRevoke', directory)
  // The read half of the trust panel: which keys a repository's own
  // `.freecodego/config.json` may contribute, which ones it set that the tier
  // does not accept, and the gate's answer. Separate from `trustFolderStatus`
  // because the gate and the document are two different questions, and a panel
  // that showed only the gate would leave a repository author who wrote a
  // non-whitelisted key with no way to see why nothing happened.
  const projectConfigReport = (workspaceRoot?: string): Promise<RemoteResult<ProjectConfigReport>> => backendCall<ProjectConfigReport>('projectConfigReport', workspaceRoot)
  const sandboxModeSet = (sessionId: string, mode: FreeCodeGoSandboxMode): Promise<RemoteResult<FreeCodeGoSandboxStatus>> => backendCall<FreeCodeGoSandboxStatus>('sandboxModeSet', sessionId, mode)
  const workbuddySetActiveAccount = (accountId: string): Promise<RemoteResult<WorkBuddyInternationalStatus>> => backendCall<WorkBuddyInternationalStatus>('workbuddySetActiveAccount', accountId)
  const mcpSave = (input: { readonly id?: string; readonly enabled: boolean; readonly transport: 'stdio' | 'streamable-http'; readonly serverName: string; readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly cwd: string; readonly url: string; readonly headers: Readonly<Record<string, string>> }): Promise<RemoteResult<CapabilitySnapshot>> => backendCall<CapabilitySnapshot>('mcpSave', input)
  const mcpRemove = (id: string): Promise<RemoteResult<CapabilitySnapshot>> => backendCall<CapabilitySnapshot>('mcpRemove', id)
  /** On-demand Skill body and companion files for the library dialog. */
  const skillDetail = (input: { readonly name: string; readonly file?: string }): Promise<RemoteResult<FreeCodeGoSkillDetail>> => backendCall<FreeCodeGoSkillDetail>('skillDetail', input)
  const skillRootSave = (input: { readonly id?: string; readonly enabled: boolean; readonly path: string }): Promise<RemoteResult<CapabilitySnapshot>> => backendCall<CapabilitySnapshot>('skillRootSave', input)
  const skillRootRemove = (id: string): Promise<RemoteResult<CapabilitySnapshot>> => backendCall<CapabilitySnapshot>('skillRootRemove', id)
  /** Set or clear one Skill's model-invocation override (`modelInvocable` omitted clears it). */
  const skillInvocationSet = (input: { readonly name: string; readonly modelInvocable?: boolean }): Promise<RemoteResult<CapabilitySnapshot>> => backendCall<CapabilitySnapshot>('skillInvocationSet', input)
  const advisorStatus = (): Promise<RemoteResult<AdvisorSnapshot>> => backendCall<AdvisorSnapshot>('advisorStatus')
  const advisorUpdate = (input: AdvisorUpdate): Promise<RemoteResult<AdvisorSnapshot>> => backendCall<AdvisorSnapshot>('advisorUpdate', input)
  const advisorModels = (): Promise<RemoteResult<readonly AdvisorModelChoice[]>> => backendCall<readonly AdvisorModelChoice[]>('advisorModels')
  const advisorNotes = (): Promise<RemoteResult<readonly AdvisorNote[]>> => backendCall<readonly AdvisorNote[]>('advisorNotes')
  const advisorReviewNow = (sessionId: string): Promise<RemoteResult<AdvisorSnapshot>> => backendCall<AdvisorSnapshot>('advisorReviewNow', sessionId)
  const engineeringEval = (): Promise<RemoteResult<FreeCodeGoEngineeringEvalReport>> => backendCall<FreeCodeGoEngineeringEvalReport>('engineeringEval')
  const engineeringMemorySearch = (sessionId: string, searchText?: string, limit?: number): Promise<RemoteResult<readonly EngineeringMemoryIndex[]>> => backendCall<readonly EngineeringMemoryIndex[]>('engineeringMemorySearch', sessionId, searchText, limit)
  const engineeringMemoryRecall = (sessionId: string): Promise<RemoteResult<FreeCodeGoEngineeringMemoryRecall>> => backendCall<FreeCodeGoEngineeringMemoryRecall>('engineeringMemoryRecall', sessionId)
  const engineeringSkillDraft = (sessionId: string): Promise<RemoteResult<FreeCodeGoEngineeringSkillDraftResult>> => backendCall<FreeCodeGoEngineeringSkillDraftResult>('engineeringSkillDraft', sessionId)
  const engineeringSpecExport = (sessionId: string, request: { readonly id: string }): Promise<RemoteResult<FreeCodeGoEngineeringSpecBundle>> => backendCall<FreeCodeGoEngineeringSpecBundle>('engineeringSpecExport', sessionId, request)
  const logfareSetKey = (value: string): Promise<RemoteResult<FreeCodeGoLogfareStatus>> => backendCall<FreeCodeGoLogfareStatus>('logfareSetKey', value)
  const accountDetail = (): Promise<RemoteResult<FreeCodeGoBackendSnapshot>> => backendCall<FreeCodeGoBackendSnapshot>('accountDetail')
  const clineAddAccount = (refreshToken: string): Promise<RemoteResult<ClineStatus>> => backendCall<ClineStatus>('clineAddAccount', refreshToken)
  const engineeringStatus = (): Promise<RemoteResult<EngineeringStatus>> => backendCall<EngineeringStatus>('engineeringStatus')
  const engineeringSetEnabled = (enabled: boolean): Promise<RemoteResult<EngineeringStatus>> => backendCall<EngineeringStatus>('engineeringSetEnabled', enabled)
  const engineeringSettingsUpdate = (input: Partial<EngineeringSettings>): Promise<RemoteResult<EngineeringStatus>> => backendCall<EngineeringStatus>('engineeringSettingsUpdate', input)
  const engineeringLoopStatus = (sessionId: string): Promise<RemoteResult<EngineeringLoopStatus>> => backendCall<EngineeringLoopStatus>('engineeringLoopStatus', sessionId)
  const engineeringLoopArm = (sessionId: string): Promise<RemoteResult<EngineeringLoopStatus>> => backendCall<EngineeringLoopStatus>('engineeringLoopArm', sessionId)
  const engineeringLoopStop = (sessionId: string): Promise<RemoteResult<EngineeringLoopStatus>> => backendCall<EngineeringLoopStatus>('engineeringLoopStop', sessionId)
  const engineeringCouncilReview = (sessionId: string): Promise<RemoteResult<{ readonly id: string; readonly findings: readonly { readonly role: string; readonly severity: string; readonly note: string }[] }>> => backendCall('engineeringCouncilReview', sessionId)
  const engineeringCouncilReports = (sessionId: string): Promise<RemoteResult<readonly { readonly id: string; readonly sessionId: string; readonly turn: number; readonly provider: string; readonly model: string; readonly createdAt: number; readonly findings: readonly { readonly role: 'architecture' | 'security' | 'testing'; readonly severity: 'nit' | 'concern' | 'blocker'; readonly note: string }[] }[]>> => backendCall('engineeringCouncilReports', sessionId)
  const engineeringTeamStart = (sessionId: string, request: { readonly objective: string; readonly plan: string; readonly constraints?: readonly string[]; readonly engines?: readonly ('deepseek' | 'codex' | 'claude')[]; readonly maxRounds?: number; readonly run_in_background?: boolean }): Promise<RemoteResult<EngineeringTeamJob>> => backendCall('engineeringTeamStart', sessionId, request)
  const engineeringTeamJob = (id: string): Promise<RemoteResult<EngineeringTeamJob>> => backendCall('engineeringTeamJob', id)
  const engineeringTeamCancel = (id: string): Promise<RemoteResult<EngineeringTeamJob>> => backendCall('engineeringTeamCancel', id)
  const engineeringTeamReports = (sessionId: string): Promise<RemoteResult<readonly EngineeringTeamReport[]>> => backendCall('engineeringTeamReports', sessionId)
  const engineeringTeamDecision = (sessionId: string, request: { readonly id: string; readonly decision: 'approved' | 'rejected' }): Promise<RemoteResult<EngineeringTeamDecision>> => backendCall('engineeringTeamDecision', sessionId, request)
  const engineeringTeamVerify = (sessionId: string, request: { readonly id: string; readonly stages?: readonly ('scope' | 'build' | 'types' | 'lint' | 'tests')[] }): Promise<RemoteResult<EngineeringTeamVerification>> => backendCall('engineeringTeamVerify', sessionId, request)
  const engineeringTeamImplementation = (sessionId: string, request: { readonly id: string; readonly summary: string }): Promise<RemoteResult<EngineeringTeamImplementation>> => backendCall('engineeringTeamImplementation', sessionId, request)
  const engineeringMemoryList = (sessionId: string, request?: { readonly trusts?: readonly ('captured' | 'draft' | 'reviewed' | 'rejected' | 'superseded')[]; readonly limit?: number; readonly cursor?: string }): Promise<RemoteResult<{ readonly records: readonly { readonly id: string; readonly title: string; readonly kind: string; readonly trust: 'captured' | 'draft' | 'reviewed' | 'rejected' | 'superseded'; readonly projectId: string; readonly createdAt: number; readonly detailTokens: number }[]; readonly nextCursor?: string }>> => backendCall('engineeringMemoryList', sessionId, request)
  const engineeringMemoryTimeline = (sessionId: string, request: { readonly id: string; readonly before?: number; readonly after?: number }): Promise<RemoteResult<{ readonly anchor: { readonly id: string; readonly title: string; readonly kind: string; readonly trust: 'captured' | 'draft' | 'reviewed' | 'rejected' | 'superseded'; readonly projectId: string; readonly createdAt: number; readonly detailTokens: number }; readonly before: readonly { readonly id: string; readonly title: string; readonly kind: string; readonly trust: 'captured' | 'draft' | 'reviewed' | 'rejected' | 'superseded'; readonly projectId: string; readonly createdAt: number; readonly detailTokens: number }[]; readonly after: readonly { readonly id: string; readonly title: string; readonly kind: string; readonly trust: 'captured' | 'draft' | 'reviewed' | 'rejected' | 'superseded'; readonly projectId: string; readonly createdAt: number; readonly detailTokens: number }[] }>> => backendCall('engineeringMemoryTimeline', sessionId, request)
  const engineeringMemoryGet = (sessionId: string, ids: readonly string[]): Promise<RemoteResult<readonly { readonly id: string; readonly title: string; readonly kind: string; readonly trust: 'captured' | 'draft' | 'reviewed' | 'rejected' | 'superseded'; readonly projectId: string; readonly createdAt: number; readonly detailTokens: number; readonly body: string; readonly tags: readonly string[]; readonly sourceEngine?: string }[]>> => backendCall('engineeringMemoryGet', sessionId, ids)
  const engineeringMemoryReview = (sessionId: string, request: { readonly id: string; readonly decision: 'reviewed' | 'rejected' | 'superseded' }): Promise<RemoteResult<{ readonly id: string; readonly title: string; readonly kind: string; readonly trust: 'captured' | 'draft' | 'reviewed' | 'rejected' | 'superseded'; readonly projectId: string; readonly createdAt: number; readonly detailTokens: number; readonly body: string; readonly tags: readonly string[]; readonly sourceEngine?: string }>> => backendCall('engineeringMemoryReview', sessionId, request)
  const engineeringMemoryDelete = (sessionId: string, id: string): Promise<RemoteResult<{ readonly deleted: true }>> => backendCall('engineeringMemoryDelete', sessionId, id)
  const engineeringMemoryPurgeProject = (sessionId: string, request?: { readonly includeReviewed?: boolean }): Promise<RemoteResult<{ readonly deleted: number }>> => backendCall('engineeringMemoryPurgeProject', sessionId, request)
  const engineeringMemoryExport = (sessionId: string): Promise<RemoteResult<{ readonly version: 1; readonly exportedAt: number; readonly projectId: string; readonly records: readonly { readonly id: string; readonly title: string; readonly kind: string; readonly trust: 'captured' | 'draft' | 'reviewed' | 'rejected' | 'superseded'; readonly projectId: string; readonly createdAt: number; readonly detailTokens: number; readonly body: string; readonly tags: readonly string[]; readonly sourceEngine?: string }[] }>> => backendCall('engineeringMemoryExport', sessionId)
  const engineeringMemoryBackup = (sessionId: string): Promise<RemoteResult<{ readonly id: string; readonly createdAt: number; readonly bytes: number }>> => backendCall('engineeringMemoryBackup', sessionId)
  const engineeringMemoryRetentionSweep = (sessionId: string, retentionDays?: number): Promise<RemoteResult<{ readonly retentionDays: number; readonly deletedMemories: number; readonly deletedOutboxEntries: number }>> => backendCall('engineeringMemoryRetentionSweep', sessionId, retentionDays)
  const engineeringMemoryConsolidate = (sessionId: string): Promise<RemoteResult<MemoryConsolidation>> => backendCall<MemoryConsolidation>('engineeringMemoryConsolidate', sessionId)
  const engineeringMemoryManifest = (sessionId: string): Promise<RemoteResult<MemoryManifest>> => backendCall<MemoryManifest>('engineeringMemoryManifest', sessionId)
  const engineeringGraphRuntimeStatus = (): Promise<RemoteResult<{ readonly state: 'unavailable' | 'ready' | 'installing' | 'error'; readonly installed: boolean; readonly version: string; readonly runtimeDirectory: string; readonly pythonPath?: string; readonly wheelDigest?: string; readonly reason?: string }>> => backendCall('engineeringGraphRuntimeStatus')
  const engineeringGraphRuntimePackages = (): Promise<RemoteResult<readonly { readonly id: 'managed-uv-python' | 'existing-python'; readonly label: string; readonly detail: string; readonly compatible: boolean; readonly requiresPath: boolean; readonly detectedPath?: string }[]>> => backendCall('engineeringGraphRuntimePackages')
  const engineeringGraphRuntimeInstall = (input: { readonly packageId: 'managed-uv-python' | 'existing-python'; readonly pythonPath?: string }): Promise<RemoteResult<{ readonly state: 'unavailable' | 'ready' | 'installing' | 'error'; readonly installed: boolean; readonly version: string; readonly runtimeDirectory: string; readonly pythonPath?: string; readonly wheelDigest?: string; readonly reason?: string }>> => backendCall('engineeringGraphRuntimeInstall', input)
  const engineeringGraphRuntimeRemove = (): Promise<RemoteResult<{ readonly state: 'unavailable' | 'ready' | 'installing' | 'error'; readonly installed: boolean; readonly version: string; readonly runtimeDirectory: string; readonly pythonPath?: string; readonly wheelDigest?: string; readonly reason?: string }>> => backendCall('engineeringGraphRuntimeRemove')
  const engineeringGraphProjectStatus = (sessionId: string): Promise<RemoteResult<{ readonly state: 'unavailable' | 'missing' | 'ready' | 'building' | 'error'; readonly projectId: string; readonly graphPath: string; readonly builtAt?: number; readonly graphBytes?: number; readonly reason?: string }>> => backendCall('engineeringGraphProjectStatus', sessionId)
  const engineeringGraphBuild = (sessionId: string, request?: { readonly force?: boolean }): Promise<RemoteResult<{ readonly state: 'unavailable' | 'missing' | 'ready' | 'building' | 'error'; readonly projectId: string; readonly graphPath: string; readonly builtAt?: number; readonly graphBytes?: number; readonly reason?: string }>> => backendCall('engineeringGraphBuild', sessionId, request)
  const engineeringGraphUpdate = (sessionId: string): Promise<RemoteResult<{ readonly state: 'unavailable' | 'missing' | 'ready' | 'building' | 'error'; readonly projectId: string; readonly graphPath: string; readonly builtAt?: number; readonly graphBytes?: number; readonly reason?: string }>> => backendCall('engineeringGraphUpdate', sessionId)
  const engineeringGraphCancel = (sessionId: string): Promise<RemoteResult<{ readonly cancelled: boolean }>> => backendCall('engineeringGraphCancel', sessionId)
  const engineeringGraphCanvas = (sessionId: string, request?: { readonly maxNodes?: number }): Promise<RemoteResult<{ readonly projectId: string; readonly generatedAt: number; readonly nodes: readonly { readonly id: string; readonly label: string; readonly kind?: string }[]; readonly edges: readonly { readonly from: string; readonly to: string; readonly kind?: string }[]; readonly truncated: boolean }>> => backendCall('engineeringGraphCanvas', sessionId, request)
  const engineeringGraphClearProject = (sessionId: string): Promise<RemoteResult<{ readonly state: 'unavailable' | 'missing' | 'ready' | 'building' | 'error'; readonly projectId: string; readonly graphPath: string; readonly builtAt?: number; readonly graphBytes?: number; readonly reason?: string }>> => backendCall('engineeringGraphClearProject', sessionId)
  const engineeringCodeGraphRuntimeStatus = (): Promise<RemoteResult<{ readonly state: 'unavailable' | 'ready' | 'installing' | 'error'; readonly installed: boolean; readonly version: string; readonly runtimeDirectory: string; readonly binaryPath?: string; readonly bundleDigest?: string; readonly reason?: string }>> => backendCall('engineeringCodeGraphRuntimeStatus')
  const engineeringCodeGraphRuntimePackages = (): Promise<RemoteResult<readonly { readonly id: 'managed-bundle'; readonly label: string; readonly detail: string; readonly compatible: boolean; readonly requiresPath: boolean }[]>> => backendCall('engineeringCodeGraphRuntimePackages')
  const engineeringCodeGraphRuntimeInstall = (): Promise<RemoteResult<{ readonly state: 'unavailable' | 'ready' | 'installing' | 'error'; readonly installed: boolean; readonly version: string; readonly runtimeDirectory: string; readonly binaryPath?: string; readonly bundleDigest?: string; readonly reason?: string }>> => backendCall('engineeringCodeGraphRuntimeInstall')
  const engineeringCodeGraphRuntimeRemove = (): Promise<RemoteResult<{ readonly state: 'unavailable' | 'ready' | 'installing' | 'error'; readonly installed: boolean; readonly version: string; readonly runtimeDirectory: string; readonly binaryPath?: string; readonly bundleDigest?: string; readonly reason?: string }>> => backendCall('engineeringCodeGraphRuntimeRemove')
  const engineeringCodeGraphProjectStatus = (sessionId: string): Promise<RemoteResult<{ readonly state: 'unavailable' | 'missing' | 'ready' | 'building' | 'error'; readonly projectId: string; readonly indexPath: string; readonly builtAt?: number; readonly indexBytes?: number; readonly reason?: string }>> => backendCall('engineeringCodeGraphProjectStatus', sessionId)
  const engineeringCodeGraphBuild = (sessionId: string, request?: { readonly force?: boolean }): Promise<RemoteResult<{ readonly state: 'unavailable' | 'missing' | 'ready' | 'building' | 'error'; readonly projectId: string; readonly indexPath: string; readonly builtAt?: number; readonly indexBytes?: number; readonly reason?: string }>> => backendCall('engineeringCodeGraphBuild', sessionId, request)
  const engineeringCodeGraphSync = (sessionId: string): Promise<RemoteResult<{ readonly state: 'unavailable' | 'missing' | 'ready' | 'building' | 'error'; readonly projectId: string; readonly indexPath: string; readonly builtAt?: number; readonly indexBytes?: number; readonly reason?: string }>> => backendCall('engineeringCodeGraphSync', sessionId)
  const engineeringCodeGraphCancel = (sessionId: string): Promise<RemoteResult<{ readonly cancelled: boolean }>> => backendCall('engineeringCodeGraphCancel', sessionId)
  const engineeringCodeGraphClearProject = (sessionId: string): Promise<RemoteResult<{ readonly state: 'unavailable' | 'missing' | 'ready' | 'building' | 'error'; readonly projectId: string; readonly indexPath: string; readonly builtAt?: number; readonly indexBytes?: number; readonly reason?: string }>> => backendCall('engineeringCodeGraphClearProject', sessionId)
  const tokenUsageLocal = (query?: import('@deepseek-ai/dsh-freecodego-harness-plugin').LocalTokenUsageQuery): Promise<RemoteResult<import('@deepseek-ai/dsh-freecodego-harness-plugin').LocalTokenUsageSnapshot>> => backendCall('tokenUsageLocal', query)
  const tokenUsageGateway = (days: number): Promise<RemoteResult<import('@deepseek-ai/dsh-freecodego-harness-plugin').GatewayUsageSnapshot>> => backendCall('tokenUsageGateway', days)
  const tokenUsageCurrentSession = (sessionId: string): Promise<RemoteResult<import('@deepseek-ai/dsh-freecodego-harness-plugin').LocalTokenUsageSnapshot | undefined>> => backendCall('tokenUsageCurrentSession', sessionId)
  // Workspace-checkpoint surface. These Remotes have existed on the Host since
  // the Cline-style shadow-snapshot store landed; the panel below is the first
  // UI consumer, so the wrappers are thin pass-throughs with the Host's own
  // request shapes.
  const engineeringCheckpointList = (sessionId: string): Promise<RemoteResult<readonly import('@deepseek-ai/dsh-freecodego-harness-plugin').FreeCodeGoEngineeringCheckpoint[]>> => backendCall('engineeringCheckpointList', sessionId)
  const engineeringCheckpointCapture = (sessionId: string, input: { readonly label: string }): Promise<RemoteResult<import('@deepseek-ai/dsh-freecodego-harness-plugin').FreeCodeGoEngineeringCheckpoint>> => backendCall('engineeringCheckpointCapture', sessionId, input)
  const engineeringCheckpointDiff = (sessionId: string, input: { readonly id: string }): Promise<RemoteResult<import('@deepseek-ai/dsh-freecodego-harness-plugin').FreeCodeGoEngineeringCheckpointDiff>> => backendCall('engineeringCheckpointDiff', sessionId, input)
  const engineeringCheckpointRestore = (sessionId: string, input: { readonly id: string }): Promise<RemoteResult<import('@deepseek-ai/dsh-freecodego-harness-plugin').FreeCodeGoEngineeringCheckpointRestoreResult>> => backendCall('engineeringCheckpointRestore', sessionId, input)
  const engineeringCheckpointRemove = (sessionId: string, input: { readonly id: string }): Promise<RemoteResult<{ readonly deleted: true }>> => backendCall('engineeringCheckpointRemove', sessionId, input)
  const engineeringCheckpointSetPinned = (sessionId: string, input: { readonly id: string; readonly pinned: boolean }): Promise<RemoteResult<{ readonly pinned: boolean }>> => backendCall('engineeringCheckpointSetPinned', sessionId, input)
  // The unified inspect surface's third door, and plan review's read/write pair.
  // All three shipped on the Host with the `engineering_inspect` tool and the
  // `engineering_plan_mode` tool; the panels are their first UI consumers, so the
  // wrappers carry the Host's own request and response shapes unchanged.
  const inspectReport = (): Promise<RemoteResult<import('@deepseek-ai/dsh-freecodego-harness-plugin').FreeCodeGoInspectReport>> => backendCall('inspectReport')
  const planReviewOpen = (sessionId: string): Promise<RemoteResult<import('@deepseek-ai/dsh-freecodego-harness-plugin').FreeCodeGoPlanReviewSurface>> => backendCall('planReviewOpen', sessionId)
  const planReviewCompose = (request: import('@deepseek-ai/dsh-freecodego-harness-plugin').FreeCodeGoPlanReviewRequest): Promise<RemoteResult<{ readonly message?: string; readonly rejected?: string }>> => backendCall('planReviewCompose', request)
  const currentSessionId = (): string | undefined => mainViewSessionId(ctx)
  const nativeModelCatalog = async (): Promise<RemoteResult<{ readonly groups: readonly { readonly id: string; readonly name: string; readonly models: readonly { readonly id: string; readonly name: string }[] }[] }>> => {
    const response = await ctx.remote.session.modelCatalog()
    return response.ok
      ? { ok: true, value: { groups: response.value.groups } }
      : response
  }
  const capabilityMarketplace = (input: { readonly kind: 'mcp' | 'skill'; readonly query?: string; readonly category?: string; readonly offset?: number; readonly limit?: number }): Promise<RemoteResult<CapabilityMarketplacePage>> => backendCall<CapabilityMarketplacePage>('capabilityMarketplace', input)
  const mcpPresetInstall = (id: string): Promise<RemoteResult<CapabilitySnapshot>> => backendCall<CapabilitySnapshot>('mcpPresetInstall', id)
  const deleteSession = async (sessionId: string): Promise<void> => {
    const result = await backendCall<{ readonly deleted: true }>('sessionDelete', sessionId)
    if (!result.ok) throw new Error(result.error.message)
    // The deleted Session may be the displayed one, but alpha.2 keeps that
    // selection on the view owner (`ISessions` has neither `clear` nor
    // `list.current` any more) and the renderer re-derives its main binding
    // from the refreshed list, so removal only has to refresh.
    await ctx.sessions.refresh()
  }

  // ui-layout owns this optional frame slot. Keep the registration erased so
  // the FreeCodeGo client remains independently type-checkable.
  const shellSlots = ctx.slots as unknown as {
    inject(name: string, setup: () => unknown): unknown
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  shellSlots.inject('shell.overlay', () => shellSlots.register({
    name: 'shell.overlay', id: 'freecodego-plugin-conflict-notice', order: 50,
    inject: () => ({ status: pluginConflictStatus }),
  }, PluginConflictNotice))
  shellSlots.inject('shell.overlay', () => shellSlots.register({
    name: 'shell.overlay', id: 'freecodego-session-delete-overlay', order: 40,
    inject: () => ({ deleteSession, capabilities, isEnabled: async () => { try { return (await readFreeCodeGoSettings()).sessionDeleteEnabled !== false } catch { return true } } }),
  }, SessionDeleteOverlay))

  // These are additive plugin slots: the core settings shell and conversation
  // composer remain untouched, while every settings page gets the same
  // language and new-session engine controls.
  ctx.slots.inject('settings.action', () => ctx.slots.register({
    name: 'settings.action',
    id: 'freecodego-language',
    order: -20,
    locale: NS,
    inject: () => ({ locale: ctx.locale, t }),
  }, LanguageAction))
  ctx.slots.inject('settings.action', () => ctx.slots.register({
    name: 'settings.action',
    id: 'freecodego-engine',
    order: -10,
    locale: NS,
    inject: () => ({ catalog: engineCatalog, setDefaultEngine, sessionId: currentSessionId(), t }),
  }, EngineAction))
  // Agent Preset's General page declares this additive row. Registering the
  // same control there keeps engine selection visible without changing the
  // Harness settings shell or preset implementation.
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'freecodego-engine-general',
    order: 40,
    locale: NS,
    inject: () => ({ catalog: engineCatalog, setDefaultEngine, sessionId: currentSessionId(), t }),
  }, EngineAction))
  // The conversation package declares this additive seat at runtime. Keep
  // this optional contribution type-erased so the plugin does not import the
  // core conversation implementation or alter its source bundle.
  const conversationSlots = ctx.slots as unknown as {
    inject(name: string, setup: () => unknown): unknown
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  const isVoiceInputEnabled = async (): Promise<boolean> => {
    try { return (await readFreeCodeGoSettings()).voiceInputEnabled !== false } catch { return true }
  }
  conversationSlots.inject('conversation.input.left', () => conversationSlots.register({
    name: 'conversation.input.left',
    id: 'freecodego-engine-composer',
    order: -10,
    locale: NS,
    // Session scope: the renderer passes the occurrence's own Session id as the
    // first positional argument (see scoped-slots `runInject`), which is exact
    // where the global read is only ever a guess.
    inject: (sessionId: string) => ({ catalog: engineCatalog, setDefaultEngine, sessionId, t }),
  }, EngineAction))
  conversationSlots.inject('conversation.input.right', () => conversationSlots.register({
    name: 'conversation.input.right',
    id: 'freecodego-voice-input',
    order: -10,
    locale: NS,
    inject: () => ({ voiceInputEnabled: isVoiceInputEnabled, voiceTranscribe: (audioBase64: string, mimeType: string, language?: string) => backendCall<{ readonly text: string; readonly model: string }>('groqWhisperTranscribe', audioBase64, mimeType, language) }),
  }, VoiceInputAction))
  conversationSlots.inject('conversation.session.header.utilities', () => conversationSlots.register({
    name: 'conversation.session.header.utilities',
    id: 'freecodego-language-session',
    order: -20,
    locale: NS,
    inject: () => ({ locale: ctx.locale, t }),
  }, LanguageAction))
  conversationSlots.inject('conversation.session.header.utilities', () => conversationSlots.register({
    name: 'conversation.session.header.utilities',
    id: 'freecodego-engine-execution',
    order: -10,
    locale: NS,
    inject: (sessionId: string) => ({ sessionId, status: sessionEngineStatus, t }),
  }, EngineExecutionBadge))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'freecodego',
    order: 30,
    label: () => t('tab'),
    locale: NS,
    inject: () => ({
      catalog,
      // The upstream locale registry may expose custom locale ids. This
      // settings surface has only Chinese and English copy, so map all other
      // ids to the English fallback instead of widening its contract.
      language: settingsLanguage(),
      accountStatus,
      login,
      register,
      sendVerifyCode,
      oauthLogin,
      oauthPendingStatus,
      oauthPendingSendVerifyCode,
      oauthPendingBind,
      oauthPendingCreate,
      completeMfa,
      logout,
      deviceSessions: () => backendCall<FreeCodeGoDeviceSessions>('accountDeviceSessions'),
      revokeDeviceSession: (deviceId: string) => backendCall<FreeCodeGoDeviceSessions>('accountRevokeDeviceSession', deviceId),
      revokeAllSessions: () => backendCall<number>('accountRevokeAllSessions'),
      setDefaultModel: (model: string) => backendCall<{ readonly model: string }>('setDefaultModel', model),
      setDefaultEngine,
      backendCatalog: () => backendCall<ManagedCatalog>('backendCatalog'),
      readMediaDefaults: async () => {
        const fallback = { image: '', video: '', audio: '' }
        const defaults = (await readFreeCodeGoSettings()).mediaDefaults
        if (defaults === null || typeof defaults !== 'object' || Array.isArray(defaults)) return fallback
        return {
          image: typeof (defaults as { image?: unknown }).image === 'string' ? (defaults as { image: string }).image : '',
          video: typeof (defaults as { video?: unknown }).video === 'string' ? (defaults as { video: string }).video : '',
          audio: typeof (defaults as { audio?: unknown }).audio === 'string' ? (defaults as { audio: string }).audio : '',
        }
      },
      nativeModelCatalog,
      vyceStatus: () => backendCall<FreeCodeGoVyceStatus>('vyceStatus'),
      vyceSetKey: (value: string) => backendCall<FreeCodeGoVyceStatus>('vyceSetKey', value),
      logfareStatus: () => backendCall<FreeCodeGoLogfareStatus>('logfareStatus'),
      logfareRegister: (input: FreeCodeGoLogfareRegistrationRequest) => backendCall<FreeCodeGoLogfareStatus>('logfareRegister', input),
      logfareSetTrainingOptIn: (enabled: boolean) => backendCall<FreeCodeGoLogfareStatus>('logfareSetTrainingOptIn', enabled),
      sensenovaStatus: () => backendCall<FreeCodeGoSenseNovaStatus>('sensenovaStatus'),
      sensenovaSetKey: (value: string) => backendCall<FreeCodeGoSenseNovaStatus>('sensenovaSetKey', value),
      nvidiaStatus: () => backendCall<FreeCodeGoNvidiaStatus>('nvidiaStatus'),
      nvidiaSetKey: (value: string) => backendCall<FreeCodeGoNvidiaStatus>('nvidiaSetKey', value),
      useConnectionEpoch,
      paymentPlans: () => backendCall<readonly { readonly id: string | number; readonly name: string; readonly description?: string; readonly price?: number; readonly originalPrice?: number; readonly currency?: string; readonly validityDays?: number; readonly validityUnit?: string; readonly features?: readonly string[]; readonly productName?: string; readonly forSale?: boolean }[]>('paymentPlans'),
      paymentChannels: () => backendCall<readonly { readonly paymentType: string; readonly currency?: string; readonly balanceRechargeMultiplier?: number; readonly feeRate?: number; readonly fixedFee?: number; readonly fixedFeeDisplayAmount?: number; readonly fixedFeeDisplayCurrency?: string; readonly singleMin?: number; readonly singleMax?: number }[]>('paymentChannels'),
      // Limits plus Stripe's publishable key; the key is what lets the card form
      // run in the panel instead of on the backend's own checkout page.
      paymentConfig: () => backendCall<{ readonly paymentEnabled?: boolean; readonly minAmount?: number; readonly maxAmount?: number; readonly dailyLimit?: number; readonly orderTimeoutMinutes?: number; readonly maxPendingOrders?: number; readonly enabledPaymentTypes?: readonly string[]; readonly balanceDisabled?: boolean; readonly balanceRechargeMultiplier?: number; readonly rechargeFeeRate?: number; readonly helpText?: string; readonly helpImageUrl?: string; readonly stripePublishableKey?: string; readonly paypalClientId?: string }>('paymentConfig'),
      gatewayModelPrices: (language: 'zh' | 'en') => backendCall<readonly GatewayModelPrice[]>('gatewayModelPrices', language),
      paymentOrders: () => backendCall<unknown>('paymentOrders'),
      paymentCheckout: (planId: number, paymentType: string, returnUrl: string, amount?: number) => backendCall<{ readonly orderId: string; readonly state: string; readonly amount: number; /** Absent when the payment provider echoed no settlement currency. */ readonly currency?: string; readonly checkoutUrl?: string; readonly qrCode?: string; readonly clientSecret?: string; readonly outTradeNo?: string; readonly payAmount?: number; readonly paymentType?: string; readonly expiresAt?: string }>('paymentCheckout', planId, paymentType, returnUrl, amount),
      paymentOrder: (orderId: string) => backendCall<{ readonly orderId: string; readonly state: string; readonly amount: number; /** Absent when the payment provider echoed no settlement currency. */ readonly currency?: string; readonly checkoutUrl?: string; readonly qrCode?: string; readonly clientSecret?: string; readonly outTradeNo?: string; readonly payAmount?: number; readonly paymentType?: string; readonly expiresAt?: string }>('paymentOrder', orderId),
      paymentVerify: (outTradeNo: string) => backendCall<{ readonly orderId: string; readonly state: string; readonly amount: number; readonly currency: string; readonly checkoutUrl?: string; readonly qrCode?: string; readonly clientSecret?: string; readonly outTradeNo?: string; readonly payAmount?: number; readonly paymentType?: string; readonly expiresAt?: string }>('paymentVerify', outTradeNo),
      paymentCancel: (orderId: string) => backendCall<{ readonly cancelled: boolean }>('paymentCancel', orderId),
      paymentReceiptEmail: (orderId: string) => backendCall<{ readonly email: string; readonly message?: string }>('paymentReceiptEmail', orderId),
      paymentReceiptDocument: (orderId: string) => backendCall<{ readonly fileName: string; readonly contentType: string; readonly content: string }>('paymentReceiptDocument', orderId),
      agnesStatus: () => backendCall<AgnesStatus>('agnesStatus'),
      clineStatus: () => backendCall<ClineStatus>('clineStatus'),
      clineStartLogin: () => backendCall<ClineDeviceLogin>('clineStartLogin'),
      clinePollLogin: (deviceCode: string) => backendCall<ClineLoginPoll>('clinePollLogin', deviceCode),
      clineRemoveAccount: (accountId: string) => backendCall<ClineStatus>('clineRemoveAccount', accountId),
      clineRefresh: (accountId?: string) => accountId === undefined ? backendCall<ClineStatus>('clineRefresh') : backendCall<ClineStatus>('clineRefresh', accountId),
      clineLogout: () => backendCall<ClineStatus>('clineLogout'),
      workbuddyStatus: () => backendCall<WorkBuddyInternationalStatus>('workbuddyStatus'),
      workbuddyImportDesktopLogin: () => backendCall<WorkBuddyInternationalStatus>('workbuddyImportDesktopLogin'),
      workbuddyOpenSignIn: () => backendCall<{ readonly opened: boolean; readonly url: string }>('workbuddyOpenSignIn'),
      workbuddyStartBrowserLogin: () => backendCall<WorkBuddyBrowserLogin>('workbuddyStartBrowserLogin'),
      workbuddyPollBrowserLogin: (state: string) => backendCall<WorkBuddyLoginPoll>('workbuddyPollBrowserLogin', state),
      workbuddyLogout: () => backendCall<WorkBuddyInternationalStatus>('workbuddyLogout'),
      workbuddyRemoveAccount: (accountId: string) => backendCall<WorkBuddyInternationalStatus>('workbuddyRemoveAccount', accountId),
      workbuddySetActiveAccount,
      workbuddyRefreshCredits: () => backendCall<WorkBuddyInternationalStatus>('workbuddyRefreshCredits'),
      agnesSendVerification: (email: string) => backendCall<{ readonly sent: boolean }>('agnesSendVerification', email),
      agnesSendPasswordReset: (email: string) => backendCall<{ readonly sent: boolean }>('agnesSendPasswordReset', email),
      agnesResetPassword: (email: string, password: string, code: string) => backendCall<{ readonly updated: boolean }>('agnesResetPassword', email, password, code),
      agnesLogin: (email: string, password: string) => backendCall<AgnesStatus>('agnesLogin', email, password),
      agnesRegister: (email: string, password: string, code: string) => backendCall<AgnesStatus>('agnesRegister', email, password, code),
      agnesCreateApiKey: (accountId?: string) => accountId === undefined ? backendCall<{ readonly configured: boolean; readonly accountId: string }>('agnesCreateApiKey') : backendCall<{ readonly configured: boolean; readonly accountId: string }>('agnesCreateApiKey', accountId),
      agnesRemoveAccount: (accountId: string) => backendCall<AgnesStatus>('agnesRemoveAccount', accountId),
      agnesRefresh: (accountId?: string) => accountId === undefined ? backendCall<AgnesStatus>('agnesRefresh') : backendCall<AgnesStatus>('agnesRefresh', accountId),
      agnesLogout: (accountId?: string) => accountId === undefined ? backendCall<AgnesStatus>('agnesLogout') : backendCall<AgnesStatus>('agnesLogout', accountId),
      codexRuntimeStatus: () => backendCall<{ readonly installed: boolean; readonly platform: string; readonly runtimeVersion?: string; readonly artifactDigest?: string; readonly reason?: string }>('codexRuntimeStatus'),
      codexRuntimePackages: () => backendCall<readonly { readonly id: string; readonly platform: string; readonly label: string; readonly runtimeVersion: string; readonly sourceRevision: string; readonly installDirectory: string; readonly compatible: boolean; readonly source: 'official'; readonly downloadURL: string }[]>('codexRuntimePackages'),
      codexRuntimeInstall: (packageID?: string) => packageID === undefined
        ? backendCall<{ readonly installed: boolean; readonly platform: string; readonly runtimeVersion?: string; readonly artifactDigest?: string; readonly reason?: string }>('codexRuntimeInstall')
        : backendCall<{ readonly installed: boolean; readonly platform: string; readonly runtimeVersion?: string; readonly artifactDigest?: string; readonly reason?: string }>('codexRuntimeInstall', packageID),
      codexRuntimeRemove: () => backendCall<{ readonly installed: boolean; readonly platform: string; readonly runtimeVersion?: string; readonly artifactDigest?: string; readonly reason?: string }>('codexRuntimeRemove'),
      claudeRuntimeStatus: () => backendCall<{ readonly installed: boolean; readonly platform: string; readonly runtimeVersion?: string; readonly artifactDigest?: string; readonly reason?: string }>('claudeRuntimeStatus'),
      claudeRuntimePackages: () => backendCall<readonly { readonly id: string; readonly platform: string; readonly label: string; readonly runtimeVersion: string; readonly sourceRevision: string; readonly installDirectory: string; readonly compatible: boolean; readonly source: 'official'; readonly downloadURL: string }[]>('claudeRuntimePackages'),
      claudeRuntimeInstall: (packageID?: string) => packageID === undefined
        ? backendCall<{ readonly installed: boolean; readonly platform: string; readonly runtimeVersion?: string; readonly artifactDigest?: string; readonly reason?: string }>('claudeRuntimeInstall')
        : backendCall<{ readonly installed: boolean; readonly platform: string; readonly runtimeVersion?: string; readonly artifactDigest?: string; readonly reason?: string }>('claudeRuntimeInstall', packageID),
      claudeRuntimeRemove: () => backendCall<{ readonly installed: boolean; readonly platform: string; readonly runtimeVersion?: string; readonly artifactDigest?: string; readonly reason?: string }>('claudeRuntimeRemove'),
      pluginUpdateStatus: () => backendCall<import('@deepseek-ai/dsh-freecodego-harness-plugin').FreeCodeGoPluginUpdateStatus>('pluginUpdateStatus'),
      pluginUpdateCheck: () => backendCall<import('@deepseek-ai/dsh-freecodego-harness-plugin').FreeCodeGoPluginUpdateStatus>('pluginUpdateCheck'),
      pluginUpdateSetEnabled: (enabled: boolean) => backendCall<import('@deepseek-ai/dsh-freecodego-harness-plugin').FreeCodeGoPluginUpdateStatus>('pluginUpdateSetEnabled', enabled),
      pluginUpdateInstall: () => backendCall<import('@deepseek-ai/dsh-freecodego-harness-plugin').FreeCodeGoPluginUpdateStatus>('pluginUpdateInstall'),
      pluginUpdateRollback: () => backendCall<import('@deepseek-ai/dsh-freecodego-harness-plugin').FreeCodeGoPluginUpdateStatus>('pluginUpdateRollback'),
      communityCatalog: () => backendCall<{ readonly updated?: string; readonly plugins: readonly { readonly name: string; readonly owner: string; readonly url: string; readonly category: string | readonly string[]; readonly iconUrl?: string; readonly screenshots?: readonly string[]; readonly description?: { readonly zh?: string; readonly en?: string }; readonly npm?: string; readonly stars?: number; readonly downloads?: number; readonly added?: string }[] }>('communityCatalog'),
      communityCatalogIcons: (urls: readonly string[]) => backendCall<Readonly<Record<string, string>>>('communityCatalogIcons', urls),
      communityEnvironment: () => backendCall<{ readonly ready: boolean; readonly platform: string; readonly node: string; readonly profile: string }>('communityEnvironment'),
      communityInstalled: () => backendCall<{ readonly installed: Record<string, string>; readonly activation: Record<string, { readonly state: string }>; readonly sources: Record<string, readonly string[]>; readonly restartRequired: boolean }>('communityInstalled'),
      communityInstall: (url: string) => backendCall<{ readonly ok: true; readonly packageNames: readonly string[]; readonly restartRequired: true }>('communityInstall', url),
      communityUninstall: (url: string) => backendCall<{ readonly ok: true; readonly packageNames: readonly string[]; readonly restartRequired: true }>('communityUninstall', url),
      capabilityMarketplace,
      mcpPresetInstall,
      skillPresetInstall: (id: string) => backendCall<CapabilitySnapshot>('skillPresetInstall', id),
      capabilities: () => backendCall<CapabilitySnapshot>('capabilities'),
      readLocalCapabilities: async () => {
        const fallback = { voiceInputEnabled: true, sessionDeleteEnabled: true }
        let value: Record<string, unknown>
        try { value = await readFreeCodeGoSettings() } catch { return fallback }
        return {
          voiceInputEnabled: value.voiceInputEnabled !== false,
          sessionDeleteEnabled: value.sessionDeleteEnabled !== false,
        }
      },
      capabilitiesSetEnabled: (input: { readonly mcpEnabled?: boolean; readonly skillEnabled?: boolean; readonly voiceInputEnabled?: boolean; readonly sessionDeleteEnabled?: boolean }) => backendCall<CapabilitySnapshot>('capabilitiesSetEnabled', input),
      setLocalCapability: async (key: 'voiceInputEnabled' | 'sessionDeleteEnabled', value: boolean): Promise<void> => {
        await updateFreeCodeGoSettings({ [key]: value })
      },
      setModelCategoryDirect: async (key: string, category: 'text' | 'image' | 'video' | 'audio'): Promise<void> => {
        const value = await readFreeCodeGoSettings()
        const existing = value.modelCategories !== null && typeof value.modelCategories === 'object' && !Array.isArray(value.modelCategories)
          ? value.modelCategories as Record<string, string>
          : {}
        await updateFreeCodeGoSettings({ modelCategories: { ...existing, [key]: category } })
      },
      modelCategorySet: (input: { readonly key: string; readonly category?: 'text' | 'image' | 'video' | 'audio' }) => backendCall<CapabilitySnapshot>('modelCategorySet', input),
      logfareSetKey,
      accountDetail,
      clineAddAccount,
      pluginConflictStatus,
      pluginConflictSetEnabled,
      headroomStatus,
      headroomSetEnabled,
      headroomUpdate,
      deferredToolsStatus,
      deferredToolsSetEnabled,
      teamStatus,
      guardSettingsStatus,
      guardSettingsUpdate,
      automationSettingsStatus,
      automationSettingsUpdate,
      sandboxModeStatus,
      sandboxModeSet,
      trustFolderStatus,
      trustFolderGrant,
      trustFolderRevoke,
      projectConfigReport,
      mcpSave: (input: { readonly id?: string; readonly enabled: boolean; readonly transport: 'stdio' | 'streamable-http'; readonly serverName: string; readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly cwd: string; readonly url: string; readonly headers: Readonly<Record<string, string>> }) => backendCall<{ readonly mcpEnabled: boolean; readonly skillEnabled: boolean; readonly mcpServers: readonly { readonly id: string; readonly enabled: boolean; readonly transport: 'stdio' | 'streamable-http'; readonly serverName: string; readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly cwd: string; readonly url: string; readonly headers: Readonly<Record<string, string>> }[]; readonly skillRoots: readonly { readonly id: string; readonly enabled: boolean; readonly path: string }[]; readonly mcpTools: readonly { readonly name: string; readonly description: string }[]; readonly skills: readonly { readonly name: string; readonly description: string; readonly source: string; readonly modelInvocable: boolean; readonly userInvocable: boolean }[] }>('mcpSave', input),
      mcpRemove: (id: string) => backendCall<{ readonly mcpEnabled: boolean; readonly skillEnabled: boolean; readonly mcpServers: readonly { readonly id: string; readonly enabled: boolean; readonly transport: 'stdio' | 'streamable-http'; readonly serverName: string; readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly cwd: string; readonly url: string; readonly headers: Readonly<Record<string, string>> }[]; readonly skillRoots: readonly { readonly id: string; readonly enabled: boolean; readonly path: string }[]; readonly mcpTools: readonly { readonly name: string; readonly description: string }[]; readonly skills: readonly { readonly name: string; readonly description: string; readonly source: string; readonly modelInvocable: boolean; readonly userInvocable: boolean }[] }>('mcpRemove', id),
      skillRootSave: (input: { readonly id?: string; readonly enabled: boolean; readonly path: string }) => backendCall<{ readonly mcpEnabled: boolean; readonly skillEnabled: boolean; readonly mcpServers: readonly { readonly id: string; readonly enabled: boolean; readonly transport: 'stdio' | 'streamable-http'; readonly serverName: string; readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly cwd: string; readonly url: string; readonly headers: Readonly<Record<string, string>> }[]; readonly skillRoots: readonly { readonly id: string; readonly enabled: boolean; readonly path: string }[]; readonly mcpTools: readonly { readonly name: string; readonly description: string }[]; readonly skills: readonly { readonly name: string; readonly description: string; readonly source: string; readonly modelInvocable: boolean; readonly userInvocable: boolean }[] }>('skillRootSave', input),
      skillRootRemove: (id: string) => backendCall<{ readonly mcpEnabled: boolean; readonly skillEnabled: boolean; readonly mcpServers: readonly { readonly id: string; readonly enabled: boolean; readonly transport: 'stdio' | 'streamable-http'; readonly serverName: string; readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly cwd: string; readonly url: string; readonly headers: Readonly<Record<string, string>> }[]; readonly skillRoots: readonly { readonly id: string; readonly enabled: boolean; readonly path: string }[]; readonly mcpTools: readonly { readonly name: string; readonly description: string }[]; readonly skills: readonly { readonly name: string; readonly description: string; readonly source: string; readonly modelInvocable: boolean; readonly userInvocable: boolean }[] }>('skillRootRemove', id),
      advisorStatus,
      advisorUpdate,
      advisorModels,
      advisorNotes,
      engineeringStatus,
      engineeringSetEnabled,
      engineeringSettingsUpdate,
      engineeringCouncilReview,
      engineeringCouncilReports,
      engineeringTeamStart,
      engineeringTeamJob,
      engineeringTeamCancel,
      engineeringTeamReports,
      engineeringTeamImplementation,
      engineeringMemoryList,
      engineeringMemoryTimeline,
      engineeringMemoryGet,
      engineeringMemoryDelete,
      engineeringMemoryPurgeProject,
      engineeringMemoryExport,
      engineeringMemoryBackup,
      engineeringMemoryRetentionSweep,
      engineeringGraphRuntimeStatus,
      engineeringGraphRuntimePackages,
      engineeringGraphRuntimeInstall,
      engineeringGraphRuntimeRemove,
      engineeringGraphProjectStatus,
      engineeringGraphBuild,
      engineeringGraphUpdate,
      engineeringGraphCancel,
      engineeringGraphCanvas,
      engineeringGraphClearProject,
      engineeringCodeGraphRuntimeStatus,
      engineeringCodeGraphRuntimePackages,
      engineeringCodeGraphRuntimeInstall,
      engineeringCodeGraphRuntimeRemove,
      engineeringCodeGraphProjectStatus,
      engineeringCodeGraphBuild,
      engineeringCodeGraphSync,
      engineeringCodeGraphCancel,
      engineeringCodeGraphClearProject,
      currentSessionId,
    }),
  }, FreeCodeGoSettingsSection))

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'freecodego-token-usage',
    order: 35,
    label: () => settingsLanguage() === 'zh' ? 'Token 消耗' : 'Token usage',
    locale: NS,
    inject: () => ({ tokenUsageLocal, tokenUsageGateway, tokenUsageCurrentSession, accountStatus, sessionId: currentSessionId(), language: settingsLanguage() }),
  }, TokenUsageDashboard))

  // Capability rows are real settings-sidebar entries, not nested tabs. Their
  // registrations follow the persisted switches and disappear immediately
  // when a switch is turned off from the FreeCodeGo settings page.
  ctx.slots.inject('settings.section', () => {
    let disposeMcp: (() => void) | undefined
    let disposeSkill: (() => void) | undefined
    let disposeAdvisor: (() => void) | undefined
    const reconcile = async (snapshot?: CapabilitySnapshot): Promise<void> => {
      const result = snapshot === undefined ? await capabilities() : { ok: true as const, value: snapshot }
      if (!result.ok) return
      if (result.value.mcpEnabled && disposeMcp === undefined) {
        disposeMcp = ctx.slots.register({
          name: 'settings.section', id: 'freecodego-mcp', order: 31,
          label: () => 'MCP', locale: NS,
          inject: () => ({ capabilities, mcpSave, mcpRemove, capabilityMarketplace, mcpPresetInstall, skillRootSave, skillRootRemove, skillInvocationSet, skillDetail, engineeringStatus, engineeringSettingsUpdate, language: settingsLanguage() }),
        }, McpSettingsSection)
      } else if (!result.value.mcpEnabled && disposeMcp !== undefined) {
        disposeMcp()
        disposeMcp = undefined
      }
      if (result.value.skillEnabled && disposeSkill === undefined) {
        disposeSkill = ctx.slots.register({
          name: 'settings.section', id: 'freecodego-skills', order: 32,
          label: () => 'Skills', locale: NS,
          inject: () => ({ capabilities, mcpSave, mcpRemove, capabilityMarketplace, mcpPresetInstall, skillRootSave, skillRootRemove, skillInvocationSet, skillDetail, engineeringStatus, engineeringSettingsUpdate, engineeringSkillDraft, currentSessionId, language: settingsLanguage() }),
        }, SkillSettingsSection)
      } else if (!result.value.skillEnabled && disposeSkill !== undefined) {
        disposeSkill()
        disposeSkill = undefined
      }
      const advisor = await advisorStatus()
      if (!advisor.ok) return
      if (advisor.value.enabled && disposeAdvisor === undefined) {
        disposeAdvisor = ctx.slots.register({
          name: 'settings.section', id: 'freecodego-advisor', order: 33,
          label: () => 'Advisor', locale: NS,
          inject: () => ({ advisorStatus, advisorUpdate, advisorModels, advisorNotes, advisorReviewNow, currentSessionId }),
        }, AdvisorSettingsSection)
      } else if (!advisor.value.enabled && disposeAdvisor !== undefined) {
        disposeAdvisor()
        disposeAdvisor = undefined
      }
    }
    const refresh = (): void => { void reconcile().catch(() => undefined) }
    const changed = (event: Event): void => {
      const snapshot = event instanceof CustomEvent ? event.detail as CapabilitySnapshot : undefined
      void reconcile(snapshot).catch(() => undefined)
    }
    refresh()
    globalThis.addEventListener(CAPABILITY_CHANGE_EVENT, changed)
    globalThis.addEventListener(ADVISOR_CHANGE_EVENT, refresh)
    const offConnection = ctx.on('connection/reset', refresh)
    return () => {
      globalThis.removeEventListener(CAPABILITY_CHANGE_EVENT, changed)
      globalThis.removeEventListener(ADVISOR_CHANGE_EVENT, refresh)
      offConnection()
      disposeMcp?.()
      disposeSkill?.()
      disposeAdvisor?.()
    }
  })

  // Engineering is optional and remains a plugin-owned settings page. Its
  // registration follows only the master switch so it never adds a dormant
  // sidebar item to installations that have not opted in.
  ctx.inject(['slots', 'sessions'], scope => scope.slots.inject('settings.section', () => {
    let disposeEngineering: (() => void) | undefined
    let registrationEpoch = 0
    /**
     * Register the Engineering section once, whichever path asks first.
     *
     * The prop list used to be written out twice — once here and once in the
     * change handler — which is the shape that lets a new prop reach one path and
     * not the other. The change handler is the path a user takes right after
     * toggling the section on, so a drift there presents as "the panel is missing
     * a control until I reload". One definition removes the possibility.
     */
    const registerEngineering = (): void => {
      if (disposeEngineering !== undefined) return
      disposeEngineering = scope.slots.register({
        name: 'settings.section', id: 'freecodego-engineering', order: 34,
        label: () => t('engineering'), locale: NS,
        inject: () => ({ engineeringStatus, engineeringSetEnabled, engineeringSettingsUpdate, engineeringLoopStatus, engineeringLoopArm, engineeringLoopStop, engineeringCouncilReview, engineeringCouncilReports, engineeringTeamStart, engineeringTeamJob, engineeringTeamCancel, engineeringTeamReports, engineeringTeamDecision, engineeringTeamVerify, engineeringTeamImplementation, engineeringMemoryList, engineeringMemorySearch, engineeringMemoryRecall, engineeringMemoryTimeline, engineeringMemoryGet, engineeringMemoryReview, engineeringMemoryDelete, engineeringMemoryPurgeProject, engineeringMemoryExport, engineeringMemoryBackup, engineeringMemoryRetentionSweep, engineeringMemoryConsolidate, engineeringMemoryManifest, engineeringGraphRuntimeStatus, engineeringGraphRuntimePackages, engineeringGraphRuntimeInstall, engineeringGraphRuntimeRemove, engineeringGraphProjectStatus, engineeringGraphBuild, engineeringGraphUpdate, engineeringGraphCancel, engineeringGraphCanvas, engineeringGraphClearProject, engineeringCodeGraphRuntimeStatus, engineeringCodeGraphRuntimePackages, engineeringCodeGraphRuntimeInstall, engineeringCodeGraphRuntimeRemove, engineeringCodeGraphProjectStatus, engineeringCodeGraphBuild, engineeringCodeGraphSync, engineeringCodeGraphCancel, engineeringCodeGraphClearProject, engineeringCheckpointList, engineeringCheckpointCapture, engineeringCheckpointDiff, engineeringCheckpointRestore, engineeringCheckpointRemove, engineeringCheckpointSetPinned, engineeringSpecExport, engineeringEval, inspectReport, planReviewOpen, planReviewCompose, currentSessionId }),
      }, EngineeringSettingsSection)
    }
    const refresh = (): void => {
      const epoch = ++registrationEpoch
      void engineeringStatus().then((result) => {
        if (epoch !== registrationEpoch) return
        if (!result.ok) return
        if (result.value.engineeringEnabled) registerEngineering()
        else if (disposeEngineering !== undefined) {
          disposeEngineering()
          disposeEngineering = undefined
        }
      }).catch(() => undefined)
    }
    const changed = (event: Event): void => {
      ++registrationEpoch
      if (!(event instanceof CustomEvent)) {  refresh(); return }
      const status = event.detail as EngineeringStatus
      if (status.engineeringEnabled) registerEngineering()
      else if (disposeEngineering !== undefined) {
        disposeEngineering()
        disposeEngineering = undefined
      }
    }
    refresh()
    globalThis.addEventListener(ENGINEERING_CHANGE_EVENT, changed)
    const offConnection = ctx.on('connection/reset', refresh)
    return () => {
      globalThis.removeEventListener(ENGINEERING_CHANGE_EVENT, changed)
      offConnection()
      disposeEngineering?.()
    }
  }))
}
