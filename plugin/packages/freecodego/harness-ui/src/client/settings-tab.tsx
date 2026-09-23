import { Component, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { decideMediaDefault } from './media-default-preference.ts'
import { formatAmountInCurrency, formatMoney, roundUpCurrency } from './money-format.ts'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgnesStatus, ClineAccountInfo, ClineDeviceLogin, ClineLoginPoll, ClineStatus, DeferredToolStatus, FreeCodeGoMediaToolStatus, FreeCodeGoAutomationSettings, FreeCodeGoAutomationSettingsUpdate, FreeCodeGoVyceStatus, FreeCodeGoDeviceSessions, FreeCodeGoTrustStatus, FreeCodeGoOAuthProvider, FreeCodeGoEngineSnapshot, FreeCodeGoEngineeringCheckpoint as EngineeringCheckpoint, FreeCodeGoEngineeringCheckpointDiff as EngineeringCheckpointDiff, FreeCodeGoEngineeringCheckpointRestoreResult as EngineeringCheckpointRestoreResult, FreeCodeGoBackendSnapshot, FreeCodeGoEngineeringEvalReport, FreeCodeGoEngineeringMemoryRecall, FreeCodeGoEngineeringSkillDraftResult, FreeCodeGoEngineeringSpecBundle, FreeCodeGoGuardSettingsStatus, FreeCodeGoSandboxMode, FreeCodeGoSandboxStatus, WorkBuddyBrowserLogin, WorkBuddyLoginPoll, QoderBrowserLogin, QoderLoginPoll, QoderStatus, TraeModel, TraeStatus, FreeCodeGoCheckinReport, FreeCodeGoGuardSettingsUpdate, FreeCodeGoInspectReport, FreeCodeGoLogfareRegistrationRequest, FreeCodeGoLogfareStatus, FreeCodeGoNvidiaStatus, FreeCodeGoPlanReviewRequest, FreeCodeGoPlanReviewSurface, FreeCodeGoPluginConflictStatus, FreeCodeGoPluginUpdateStatus, FreeCodeGoRegistrationRequest, FreeCodeGoSenseNovaStatus, FreeCodeGoSkillPackStatus, FreeCodeGoSkillPlacement, FreeCodeGoSkillPlacements, HeadroomStats, WorkBuddyInternationalAccountInfo, WorkBuddyInternationalStatus, MemoryConsolidation, MemoryManifest, FreeCodeGoReviewStartRequest, FreeCodeGoReviewStatus, FreeCodeGoReviewUpdate, ProjectConfigReport } from '@deepseek-ai/dsh-freecodego-harness-plugin'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, InjectFace, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import css from './settings-tab.module.css'
import { CapabilityDetailModal, SkillDetailModal } from './capability-detail.tsx'
import { capabilityText, hasLocalizedSkillDescription, localizedSkillDescription, skillPageText, type SkillPageText } from './capability-locale.ts'
import { CommunityPluginsPage } from './community-plugins.tsx'
import { PaymentDialog, orderStateLabel, safeCheckoutUrl, type PaymentDialogOrder } from './payment-dialog.tsx'
import { ProviderCard, ProviderGlyph } from './provider-card.tsx'
import { ProviderModelVisibility, type ProviderPickerModel } from './provider-model-visibility.tsx'

/**
 * The rejection arm for a remote read whose failure is already covered.
 *
 * These effects re-run when `connectionEpoch` changes and render the previous
 * snapshot meanwhile, so a rejected call has nothing new to say: an error state
 * here would be cleared by the next poll and would flicker on the way. What is
 * not covered is the promise itself — with no rejection arm a Host disconnect
 * escaped as an unhandled rejection out of a render-pass effect. Named rather
 * than inlined so the reason is written once instead of once per poller.
 */
const ignoreRejection = (): void => undefined

/** Dedicated MCP glyph used by presets and configured-server cards. */
function McpIcon({ size = 16 }: { readonly size?: number }): ReactNode {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="3" cy="8" r="1.7" fill="currentColor" />
    <circle cx="13" cy="3" r="1.7" fill="currentColor" />
    <circle cx="13" cy="13" r="1.7" fill="currentColor" />
    <path d="M4.5 7.2 11.5 3.8M4.5 8.8l7 3.4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
  </svg>
}

/**
 * Telegram paper plane, used by the overview page's community row.
 *
 * The plane is drawn on its own in `currentColor` rather than inside the
 * brand's blue disc, so it is a dark glyph on the light card and a light one
 * in dark theme, like every other icon in this panel. The geometry is the
 * plane sub-path of the `simple-icons` Telegram glyph.
 *
 * `viewBox` is that sub-path's own bounding box inside the shared 24x24 icon
 * grid (x 4.592..18.098, y 7.189..18.023) plus half a unit of padding. Left on
 * the full grid the glyph would be inset by the disc it no longer draws and
 * render a third smaller than `size` asks for.
 */
function TelegramIcon({ size = 16 }: { readonly size?: number }): ReactNode {
  return <svg className={css.telegramIcon} width={size} height={size} viewBox="4.092 6.689 14.506 11.834" aria-hidden="true">
    <path fill="currentColor" d="M16.962 7.224c.1-.002.321.023.465.14a.5.5 0 0 1 .171.325c.016.093.036.306.02.472c-.18 1.898-.962 6.502-1.36 8.627c-.168.9-.499 1.201-.82 1.23c-.696.065-1.225-.46-1.9-.902c-1.056-.693-1.653-1.124-2.678-1.8c-1.185-.78-.417-1.21.258-1.91c.177-.184 3.247-2.977 3.307-3.23c.007-.032.014-.15-.056-.212s-.174-.041-.249-.024q-.159.037-5.061 3.345q-.72.495-1.302.48c-.428-.008-1.252-.241-1.865-.44c-.752-.245-1.349-.374-1.297-.789q.04-.324.893-.663q5.247-2.286 6.998-3.014c3.332-1.386 4.025-1.627 4.476-1.635z" />
  </svg>
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.freecodego': string
  }
}

interface Catalog {
  readonly defaultEngine: string
  readonly defaultModel?: string
  readonly mediaDefaults?: { readonly image: string; readonly video: string; readonly audio: string }
  readonly engines: readonly FreeCodeGoEngineSnapshot[]
}
interface ManagedCatalog { readonly catalogRevision: string; readonly groups?: readonly { readonly id: number; readonly name: string; readonly enabled: boolean; readonly default?: boolean; readonly rateMultiplier?: number; readonly sortOrder?: number }[]; readonly models: readonly { readonly id: string; readonly displayName: string; readonly provider: string; readonly providerName?: string; readonly protocol: string; readonly availability: string; readonly compatibleEngines: readonly string[]; readonly choices: readonly { readonly routeKey: string; readonly label: string; readonly availability: string; readonly compatibleEngines: readonly string[]; readonly zeroPrice?: boolean; readonly locked?: boolean; readonly rateMultiplier?: number; readonly groupName?: string; readonly groupId?: number; readonly protocol?: string; readonly enabled?: boolean; readonly access?: string; readonly unlockRequired?: boolean; readonly unlockReason?: string; readonly unlockExpiresAt?: string }[] }[] }
type ModelCategory = 'text' | 'image' | 'video' | 'audio'

interface NativeCatalogModel { readonly key: string; readonly provider: string; readonly providerName: string; readonly id: string; readonly displayName: string }
interface NativeModelCatalog { readonly groups: readonly { readonly id: string; readonly name: string; readonly models: readonly { readonly id: string; readonly name: string }[] }[] }

function modelCategoryKey(provider: string, model: string): string { return `${provider}\u0000${model}` }

function visibleModelId(provider: string | undefined, model: string): string {
  const stripped = provider?.toLowerCase() === 'logfare' ? model.replace(/^logfare\//i, '') : model
  // A group-pinned gateway id reads as a route, not a name: the picker labels
  // the group separately, so the bare model id is what belongs here.
  return displayModelSelection(stripped)
}

function inferredModelCategory(provider: string, id: string, displayName: string): ModelCategory {
  const value = `${provider} ${id} ${displayName}`.toLowerCase()
  if (/(?:veo(?:\d|[-_.])|seedance|kling|可灵|sora|wan[-_.]?\d.*video|grok.*video|video[-_. ]?(?:gen|create|generation))/.test(value)) return 'video'
  if (/(?:gpt[-_.]?image|dall[-_.]?e|imagen|gemini.*image|imagegen|flux|sdxl|stable[-_. ]?diffusion|midjourney|ideogram|recraft|qwen[-_.]?image|grok.*image|image[-_. ]?(?:gen|edit|generation))/.test(value)) return 'image'
  if (/(?:tts|text[-_. ]?to[-_. ]?speech|speech[-_. ]?(?:gen|synth)|audio[-_. ]?(?:gen|speech)|whisper|transcri)/.test(value)) return 'audio'
  return 'text'
}

export function modelCategoryOf(model: ManagedCatalog['models'][number], overrides: Readonly<Record<string, ModelCategory>> = {}): ModelCategory {
  const override = overrides[modelCategoryKey(model.provider, model.id)]
  if (override !== undefined) return override
  if (model.protocol === 'image_generation') return 'image'
  if (model.protocol === 'video_generation') return 'video'
  if (model.protocol === 'audio_transcription' || model.protocol === 'audio_speech') return 'audio'
  return inferredModelCategory(model.provider, model.id, model.displayName)
}

function flattenNativeModelCatalog(catalog: NativeModelCatalog): readonly NativeCatalogModel[] {
  return catalog.groups.flatMap(group => group.models.map(model => ({
    key: modelCategoryKey(group.id, model.id), provider: group.id, providerName: group.name, id: model.id, displayName: model.name,
  }))).sort((left, right) => left.providerName.localeCompare(right.providerName, 'zh-Hans-CN') || left.displayName.localeCompare(right.displayName, 'zh-Hans-CN'))
}

function mediaSelectionId(provider: string, model: string): string {
  const normalizedProvider = provider.trim().toLowerCase()
  if (normalizedProvider === 'freecodego' || model.toLowerCase().startsWith(`${normalizedProvider}/`)) return model
  return `${provider}/${model}`
}

function withNativeMediaModels(catalog: ManagedCatalog, nativeModels: readonly NativeCatalogModel[], categories: Readonly<Record<string, ModelCategory>>): ManagedCatalog {
  const byRoute = new Map(catalog.models.map(model => [`${model.provider.toLowerCase()}\u0000${model.id.toLowerCase()}`, model]))
  for (const model of nativeModels) {
    const category = categories[model.key] ?? inferredModelCategory(model.provider, model.id, model.displayName)
    if (category === 'text') continue
    const id = mediaSelectionId(model.provider, model.id)
    const entry: ManagedCatalog['models'][number] = {
      id,
      displayName: model.displayName,
      provider: model.provider,
      providerName: model.providerName,
      protocol: category === 'image' ? 'image_generation' : category === 'video' ? 'video_generation' : 'audio_speech',
      availability: 'available',
      compatibleEngines: [],
      choices: [{ routeKey: id, label: model.providerName, availability: 'available', compatibleEngines: [] }],
    }
    byRoute.set(`${model.provider.toLowerCase()}\u0000${id.toLowerCase()}`, entry)
  }
  return { ...catalog, models: [...byRoute.values()] }
}

function mediaProviderName(model: ManagedCatalog['models'][number]): string {
  if (model.provider.toLowerCase() === 'logfare') return 'logfare'
  // Same rule as `modelGroupLabel`: the provider is real data from the backend,
  // while `choices[0].label` is an internal route key or a marketing line — a
  // name no user ever picks from, printed in a dropdown they read.
  return model.providerName?.trim() || model.provider
}

/**
 * Heading for a model the backend placed in no group.
 *
 * Gateway rows the backend never grouped (Logfare, Agnes, the local Groq
 * floor, native media models) fall back to their provider, which is the honest
 * category for them: their `choices[0].label` is either an internal route key
 * or a marketing line, never a name a user picks from.
 */
export function modelGroupLabel(model: ManagedCatalog['models'][number]): string {
  return model.providerName?.trim() || model.provider
}

/** One picker row: a model as it is offered through one backend group. */
export interface ModelPickerRow {
  /** Unique per row — a model offered by two groups really is two rows. */
  readonly key: string
  readonly model: ManagedCatalog['models'][number]
  /** The rate this row is billed at; `0` is free. */
  readonly rateMultiplier?: number
  readonly zeroPrice: boolean
  /** Backend group this row bills through; absent = no grouped choices.
   * Selecting the row persists `id@group:<n>` so routing serves exactly this
   * group instead of whatever the Host would otherwise route. */
  readonly groupId?: number
}

/** Selection value for a picker row: the group pin rides in the id. */
export function modelRowSelectionValue(row: ModelPickerRow): string {
  return row.groupId === undefined ? row.model.id : `${row.model.id}@group:${row.groupId}`
}

/**
 * The backend's account-default group, under the backend's own name.
 *
 * An unpinned selection is routed through this group, not through a locally
 * chosen cheapest one (`selectModelOptionChoice` compares no rates). The
 * settings surface therefore has to name it: otherwise "which group serves when
 * I picked no row" is a rule the user cannot see. `undefined` means the backend
 * declared none — the user's own group row is then the only thing deciding.
 */
export function backendDefaultGroupName(groups: ManagedCatalog['groups'] = []): string | undefined {
  return groups.find(group => group.default === true)?.name
}

/** The account's groups, in the order the backend asked for them. */
function orderedModelGroups(groups: ManagedCatalog['groups'] = []): readonly NonNullable<ManagedCatalog['groups']>[number][] {
  return [...groups].sort((left, right) => (left.sortOrder ?? Number.MAX_SAFE_INTEGER) - (right.sortOrder ?? Number.MAX_SAFE_INTEGER))
}

/**
 * Bucket models into `[groupLabel, rows]` pairs for the picker's optgroups.
 *
 * The heading is the backend's *group*, not the model's vendor: a group is what
 * the account actually buys through, it is where the rate comes from, and the
 * same model can legitimately be offered by two groups at two different rates.
 * Groups keep the backend's `sortOrder`; models keep catalog order inside a
 * group; rows the backend never grouped land under their provider.
 */
export function modelGroupRows(
  models: readonly ManagedCatalog['models'][number][],
  groups: ManagedCatalog['groups'] = [],
): readonly (readonly [string, readonly ModelPickerRow[]])[] {
  const buckets = new Map<string, ModelPickerRow[]>()
  const seen = new Set<string>()
  const push = (label: string, row: ModelPickerRow): void => {
    // One row per (model, group). The backend can list a group's option twice
    // — one model arrived from `/models/options` as two byte-identical
    // `group:2:gpt-5.6-terra` choices — and a catalog cached before that was
    // collapsed still carries the repeat. Two rows with one key are one row:
    // rendering both reads as a defect in the list rather than as a choice.
    // Distinct groups keep distinct keys (`provider:id:groupId`), so a model
    // sold through two groups still shows both rows and both rates.
    if (seen.has(row.key)) return
    seen.add(row.key)
    const rows = buckets.get(label) ?? []
    rows.push(row)
    buckets.set(label, rows)
  }
  const ordered = orderedModelGroups(groups)
  for (const model of models) {
    const grouped = model.choices.filter(choice => choice.groupId !== undefined)
    if (grouped.length === 0) {
      const choice = model.choices[0]
      push(modelGroupLabel(model), {
        key: `${model.provider}:${model.id}`,
        model,
        zeroPrice: choice?.zeroPrice === true || choice?.rateMultiplier === 0,
        ...(choice?.rateMultiplier === undefined ? {} : { rateMultiplier: choice.rateMultiplier }),
      })
      continue
    }
    // One row per group the model is reachable through, so a model offered by
    // two groups appears twice — that duplicate is the information.
    for (const choice of grouped) {
      const group = ordered.find(candidate => candidate.id === choice.groupId)
      // The heading is the group's name alone — the rate belongs on the row, so
      // two groups offering the same model each show their own.
      const label = group?.name ?? ((choice.groupName ?? '').trim() || modelGroupLabel(model))
      // A group's rate is already the account's effective rate; the per-choice
      // rate is the fallback for a deployment that publishes groups without one.
      const rateMultiplier = group?.rateMultiplier ?? choice.rateMultiplier
      const zeroPrice = group?.rateMultiplier === 0 || choice.zeroPrice === true || choice.rateMultiplier === 0
      push(label, {
        key: `${model.provider}:${model.id}:${choice.groupId}`,
        model,
        zeroPrice,
        ...(rateMultiplier === undefined ? {} : { rateMultiplier }),
        ...(choice.groupId === undefined ? {} : { groupId: choice.groupId }),
      })
    }
  }
  return [...buckets]
}

/** Rate shown beside a picker row; a free group says so instead of `×0`. */
function pickerRowRateLabel(row: ModelPickerRow, language: 'zh' | 'en'): string {
  if (row.zeroPrice) return language === 'zh' ? '免费' : 'Free'
  return row.rateMultiplier === undefined ? '' : `×${row.rateMultiplier}`
}

/** How a persisted selection maps onto the rows the picker can offer today. */
interface PickerSelection {
  /** The value the `<select>` must carry: a matching row's value, or the stored id. */
  readonly value: string
  /** Whether that value belongs to a rendered option. */
  readonly listed: boolean
}

/** Match a persisted selection to the option value it would be saved as today.
 *
 * Rows are keyed by (model, group) and their option value carries the group
 * pin (`id@group:N`). A default persisted by an older build holds the bare id,
 * and a select whose value matches no option renders blank — so the bare id
 * resolves to that model's first row (the unpinned id equals the bare value),
 * keeping the stored default visible instead of dropping the selection.
 *
 * `listed: false` is the third case, and it is the one the caller has to
 * render: an HTML select whose value has no option shows its first option, so a
 * stored model that the current catalog does not offer (retired, currently
 * unavailable, or the provider is not configured in this install) used to be
 * displayed as an *unrelated* model — the panel claiming a default the user
 * never chose, and the next reopen showing that same stranger again. */
function pickSelection(selected: string, groups: readonly (readonly [string, readonly ModelPickerRow[]])[]): PickerSelection {
  if (selected === '') return { value: '', listed: true }
  for (const [, rows] of groups) {
    if (rows.some(row => modelRowSelectionValue(row) === selected)) return { value: selected, listed: true }
  }
  const bare = displayModelSelection(selected)
  for (const [, rows] of groups) {
    const match = rows.find(row => modelRowSelectionValue(row) === bare || row.model.id === bare)
    if (match !== undefined) return { value: modelRowSelectionValue(match), listed: true }
  }
  return { value: selected, listed: false }
}

/** Local UI floor: only the free Groq transcription row that the Host executes
 * locally. Every other media model (Agnes, Logfare, gateway) comes from the
 * backend's live catalog — `backendCatalog` already merges the provider's live
 * `/models` directories, so no client-side roster is needed. */
const LOCAL_MEDIA_MODEL_CATALOG: ManagedCatalog['models'] = [
  { id: 'whisper-large-v3-turbo', displayName: 'Whisper Large V3 Turbo', provider: 'groq', protocol: 'audio_transcription', availability: 'available', compatibleEngines: [], choices: [{ routeKey: 'whisper-large-v3-turbo', label: 'Groq 免费语音转文本', availability: 'available', compatibleEngines: [] }] },
]
const emptyManagedCatalog: ManagedCatalog = { catalogRevision: 'not-authenticated', models: [] }

/** The backend catalog is already the live merged directory (gateway +
 * Logfare + Agnes `/models`). This pass only appends the local Groq row and
 * dedupes; it no longer injects a hardcoded provider roster. */
function withAgnesModels(catalog: ManagedCatalog): ManagedCatalog {
  const seen = new Set(catalog.models.map(model => `${model.provider.toLowerCase()}\u0000${model.id.toLowerCase()}`))
  const auxiliary = LOCAL_MEDIA_MODEL_CATALOG.filter(model => !seen.has(`groq\u0000${model.id.toLowerCase()}`))
  return { ...catalog, models: [...catalog.models, ...auxiliary] }
}

function withProviderAvailability(catalog: ManagedCatalog, mysteryConfigured: boolean, mysteryPremium: boolean): ManagedCatalog {
  return {
    ...catalog,
    models: catalog.models.map(model => model.provider.toLowerCase() === 'logfare'
      ? { ...model, availability: !mysteryConfigured ? 'unavailable' : model.id.endsWith('/gpt-image-2') ? mysteryPremium ? 'available' : 'unavailable' : model.availability }
      : model),
  }
}

function RuntimePackagePicker(input: {
  readonly packages: readonly RuntimePackage[]
  readonly busy: boolean
  readonly onCancel: () => void
  readonly onInstall: (packageID: string) => void
  readonly language: 'zh' | 'en'
  readonly t: TranslateNS<'settings.freecodego'>
}): ReactNode {
  const copy = input.language === 'zh'
    ? { dialog: '选择 Runtime 安装包', detail: '选择官方平台运行包。下载完成后会自动校验并安装到 Harness runtime 目录。', loading: '正在读取可用平台包…', compatible: '当前平台，可下载并安装', incompatible: '其他平台，不可安装', install: '下载并安装', unavailable: '不兼容', managed: '安装位置由 Harness 管理，不需要手动复制到插件目录。', cancel: '取消' }
    : { dialog: 'Runtime package selection', detail: 'Choose an official platform runtime package. It is verified and installed into the Harness runtime directory after download.', loading: 'Reading available platform packages...', compatible: 'Current platform, ready to download and install', incompatible: 'Different platform, unavailable', install: 'Download and install', unavailable: 'Incompatible', managed: 'Harness manages the install location; do not copy files into the plugin directory.', cancel: 'Cancel' }
  return <div className={css.accountManager} role="dialog" aria-label={copy.dialog}>
    <small className={css.sectionMeta}>{copy.detail}</small>
    {input.packages.length === 0 ? <small className={css.sectionMeta}>{copy.loading}</small> : <div className={css.accountList}>
      {input.packages.map(item => <div className={css.accountRow} key={item.id}>
        <div className={css.accountIdentity}>
          <strong className={css.accountName}>{item.label}</strong>
          <small className={css.accountEmail}>{item.runtimeVersion} · {item.compatible ? copy.compatible : copy.incompatible}</small>
        </div>
        <button className={`${css.button} ${css.buttonPrimary}`} type="button" onClick={() => { input.onInstall(item.id) }} disabled={input.busy || !item.compatible}>{input.busy ? input.t('installing') : item.compatible ? copy.install : copy.unavailable}</button>
      </div>)}
    </div>}
    <div className={css.accountActions}><small className={css.sectionMeta}>{copy.managed}</small><button className={css.button} type="button" onClick={input.onCancel} disabled={input.busy}>{copy.cancel}</button></div>
  </div>
}

interface AccountState {
  /**
   * `loading` is the client's own pre-read state, and it is what the settings
   * cache and the first mount seed.
   *
   * The cache carries no account data, and the Host answers `accountStatus` only
   * after it has tried to restore the vault session — which is a network round
   * trip. Seeding a signed-out state painted a login form over an account that
   * was about to appear, so nothing renders the sign-in card until a read has
   * actually settled on a signed-out status.
   */
  readonly status: 'signed-out' | 'mfa-required' | 'authenticated' | 'reauth-required' | 'restoring' | 'loading' | 'backend-not-configured'
  readonly emailMasked?: string
  readonly user?: { readonly username: string; readonly email: string; readonly avatarUrl?: string; readonly balance: number }
}

interface PaymentPlan { readonly id: string | number; readonly name: string; readonly description?: string; readonly price?: number; readonly originalPrice?: number; readonly currency?: string; readonly validityDays?: number; readonly validityUnit?: string; readonly features?: readonly string[]; readonly productName?: string; readonly forSale?: boolean }
interface PaymentChannel { readonly paymentType: string; readonly currency?: string; readonly balanceRechargeMultiplier?: number; readonly feeRate?: number; readonly fixedFee?: number; readonly fixedFeeDisplayAmount?: number; readonly fixedFeeDisplayCurrency?: string; readonly singleMin?: number; readonly singleMax?: number }
/** Desktop checkout configuration: real limits plus Stripe's publishable key. */
interface PaymentConfigSnapshot { readonly paymentEnabled?: boolean; readonly minAmount?: number; readonly maxAmount?: number; readonly dailyLimit?: number; readonly orderTimeoutMinutes?: number; readonly maxPendingOrders?: number; readonly enabledPaymentTypes?: readonly string[]; readonly balanceDisabled?: boolean; readonly balanceRechargeMultiplier?: number; readonly rechargeFeeRate?: number; readonly helpText?: string; readonly helpImageUrl?: string; readonly stripePublishableKey?: string; readonly paypalClientId?: string }
export interface GatewayModelPrice { readonly modelId: string; readonly displayName: string; readonly provider: string;  readonly source: 'gateway' | 'vyce' | 'empero' | 'opencode' | 'openrouter' | 'logfare' | 'workbuddy' | 'agnes' | 'sensenova' | 'nvidia'; readonly groupName: string; readonly platform?: string; readonly rateMultiplier: number; readonly billingMode: 'token' | 'per-request' | 'image'; readonly currency: string; readonly description?: string; readonly originalInputPricePerMillion?: number; readonly originalOutputPricePerMillion?: number; readonly originalCacheReadPricePerMillion?: number; readonly originalCacheWritePricePerMillion?: number; readonly originalPerRequestPrice?: number; readonly originalImageOutputPricePerMillion?: number; readonly inputPricePerMillion?: number; readonly outputPricePerMillion?: number; readonly cacheReadPricePerMillion?: number; readonly cacheWritePricePerMillion?: number; readonly perRequestPrice?: number; readonly imageOutputPricePerMillion?: number; readonly imagePrices?: readonly GatewayImagePriceTier[] }
/** One resolution tier of an image-billing row: the price of one generated picture. */
export interface GatewayImagePriceTier { readonly label: string; readonly price: number; readonly originalPrice?: number }
interface PaymentOrder { readonly orderId: string; readonly state: string; readonly amount: number; /** Settlement currency of `payAmount`; absent when the payment provider echoed none. */ readonly currency?: string; readonly checkoutUrl?: string; readonly qrCode?: string; readonly clientSecret?: string; readonly outTradeNo?: string; readonly payAmount?: number; readonly paymentType?: string; readonly expiresAt?: string; readonly createdAt?: string; /**
 * When the payment settled, as the backend stamped it.
 *
 * Kept apart from {@link createdAt} because a receipt row states the payment,
 * not the order: an order opened at 23:59 and paid at 00:01 belongs to the
 * second day, and a list that filed it under the first would be wrong about the
 * one fact the reader is checking. Absent while an order is unpaid and on rows
 * whose backend predates the field, which is what the fallback in
 * {@link orderReceiptStamp} exists for.
 */ readonly paidAt?: string; /**
 * The backend's own answer to "can this order's receipt be downloaded".
 *
 * Carried rather than derived, because the backend is the one that decides it
 * from the order status and it owns a wider vocabulary than this panel asks for.
 * This product sells no refunds, so the refund family is never requested and
 * never arrives — which is exactly why the list below cannot be treated as the
 * authority: it describes the states this panel asks for, not every state the
 * backend can answer with. Absent on a response that predates the field, which
 * is what the state fallback in {@link orderReceiptAvailable} is for.
 */ readonly receiptAvailable?: boolean; /**
 * Whether Stripe holds a receipt for this order.
 *
 * Its own flag rather than a second meaning for the one above: a Stripe payment
 * has two documents, and an order can carry the backend's receipt while Stripe
 * has none of its own yet.
 */ readonly stripeReceiptAvailable?: boolean }
interface RuntimePackage { readonly id: string; readonly platform: string; readonly label: string; readonly runtimeVersion: string; readonly sourceRevision: string; readonly installDirectory: string; readonly compatible: boolean; readonly source: 'official'; readonly downloadURL: string }
export interface CapabilityMcpServer { readonly id: string; readonly enabled: boolean; readonly transport: 'stdio' | 'streamable-http'; readonly serverName: string; readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly cwd: string; readonly url: string; readonly headers: Readonly<Record<string, string>> }
export interface CapabilitySkillRoot { readonly id: string; readonly enabled: boolean; readonly path: string }
/**
 * One discovered Skill as the library page lists it.
 *
 * The invocation flags travel with the row because the list is the user-facing
 * inventory: it keeps Skills the model may not auto-invoke, and the page has to
 * say which is which rather than looking like the model can fire them all.
 */
export interface CapabilitySkillEntry { readonly name: string; readonly description: string; readonly source: string; readonly modelInvocable: boolean; readonly userInvocable: boolean }
/** One file beside a Skill's `SKILL.md`. */
export interface CapabilitySkillFile { readonly path: string; readonly bytes: number }
/** Body and companion files for the Skill detail dialog, loaded on demand. */
export interface CapabilitySkillDetail extends CapabilitySkillEntry { readonly content: string; readonly files: readonly CapabilitySkillFile[]; readonly file?: { readonly path: string; readonly bytes: number; readonly content: string } }

export interface CapabilitySnapshot { readonly mcpEnabled: boolean; readonly skillEnabled: boolean; readonly voiceInputEnabled?: boolean; readonly sessionDeleteEnabled?: boolean; readonly modelCategories?: Readonly<Record<string, ModelCategory>>; readonly mcpServers: readonly CapabilityMcpServer[]; readonly skillRoots: readonly CapabilitySkillRoot[];  readonly mcpTools: readonly { readonly name: string; readonly description: string }[]; readonly skills: readonly CapabilitySkillEntry[]; readonly skillInvocationOverrides?: Readonly<Record<string, boolean>> | undefined; readonly mountErrors?: readonly { readonly id: string; readonly message: string }[] }
interface MarketplaceMcpItem { readonly id: string; readonly kind: 'mcp'; readonly title: string; readonly description: string; readonly category: string; readonly sourceUrl: string; readonly iconUrl?: string; readonly author?: string; readonly popularity: number; readonly installed: boolean; readonly installable: boolean; readonly requiresConfiguration?: boolean }
interface MarketplaceMcpPage { readonly kind: 'mcp'; readonly total: number; readonly offset: number; readonly limit: number; readonly items: readonly MarketplaceMcpItem[] }
export interface AdvisorSnapshot {
  readonly enabled: boolean
  readonly mode: 'async' | 'catchup' | 'blocker-only'
  readonly provider?: string
  readonly model?: string
  readonly routeReady: boolean
  readonly reviewTools: readonly ('read' | 'glob' | 'grep')[]
  readonly allowAgentControl: boolean
  readonly interruptCooldownTurns: number
  readonly activeSessions: number
  readonly queuedReviews: number
  readonly noteCount: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly lastError?: string
  readonly backoffRemainingTurns?: number
  readonly watchdogFiles: readonly string[]
  readonly sideChannelWarnings?: readonly string[]
}
export interface AdvisorUpdate {
  readonly advisorEnabled?: boolean
  readonly advisorMode?: 'async' | 'catchup' | 'blocker-only'
  readonly advisorProvider?: string
  readonly advisorModel?: string
  readonly advisorAllowAgentControl?: boolean
  readonly advisorInterruptCooldownTurns?: number
}
export interface AdvisorModelChoice {
  readonly id: string
  readonly displayName: string
  readonly provider: string
  readonly description: string
}
export interface AdvisorNote {
  readonly id: string
  readonly sessionId: string
  readonly turn: number
  readonly severity: 'nit' | 'concern' | 'blocker'
  readonly note: string
  readonly delivery: 'record' | 'inject' | 'steer'
  readonly time: number
}

/** Durable phase of a goal, mirrored from the Host boundary type. */
export type EngineeringLoopPhase = 'active' | 'paused' | 'blocked' | 'complete'

/**
 * The autonomous engineering loop of one session.
 *
 * Shown next to the switches because the switches only say what is *allowed*:
 * the goal, its phase, whether continuation is armed, and how much of the round
 * budget is gone all change without anyone touching the settings page.
 */
export interface EngineeringLoopStatus {
  readonly available: boolean
  readonly autoContinueEnabled: boolean
  readonly goalId?: string
  readonly phase?: EngineeringLoopPhase
  /** Process-local continuation, which can be `disarmed` while the goal stays `active`. */
  readonly activation?: 'armed' | 'disarmed'
  readonly roundsStarted?: number
  readonly maxGoalRounds?: number
  readonly createdAt?: number
  readonly updatedAt?: number
  readonly blockedCode?: string
  readonly blockedMessage?: string
  readonly objectiveExcerpt?: string
}

export interface EngineeringSettings {
  readonly engineeringEnabled: boolean
  readonly engineeringSkillsEnabled: boolean
  /** The default-on starter subset in its own asset root. */
  readonly engineeringStarterSkillsEnabled: boolean
  /** The vendored superpowers workflow pack (MIT); separate and off by default. */
  readonly engineeringSuperpowersSkillsEnabled: boolean
  /** Session-start capability map of the mounted Skills. */
  readonly engineeringSkillMapEnabled: boolean
  /** The autonomous engineering loop. The host reads all four; exposing only
   *  some of them left the loop's documented "explicit opt-in" unreachable. */
  readonly engineeringLoopCapturePlan: boolean
  readonly engineeringLoopVerifyOnComplete: boolean
  readonly engineeringLoopAutoContinue: boolean
  readonly engineeringLoopMaxGoalRounds: number
  readonly engineeringQualityEnabled: boolean
  readonly engineeringMemoryEnabled: boolean
  readonly engineeringCouncilEnabled: boolean
  readonly engineeringCouncilDeepseekEnabled: boolean
  readonly engineeringCouncilCodexEnabled: boolean
  readonly engineeringCouncilClaudeEnabled: boolean
  readonly engineeringMemoryContextTokenBudget: number
  readonly engineeringCodeGraphEnabled: boolean
  readonly engineeringCodeGraphAutoUpdate: boolean
  readonly engineeringGraphEngine: 'auto' | 'graphify' | 'codegraph'
  readonly engineeringCouncilMaxRounds: number
  readonly engineeringCouncilTimeoutMs: number
  readonly engineeringCouncilQuorum: number
  readonly engineeringCouncilAutoRun: boolean
  readonly engineeringCouncilMaxTokens: number
  readonly engineeringCouncilMaxConcurrent: number
  readonly engineeringCouncilDecisionTtlMs: number
}

export interface EngineeringStatus extends EngineeringSettings {
  readonly modules: readonly { readonly id: string; readonly state: 'disabled' | 'available' | 'unavailable' | 'error'; readonly detail: string }[]
  readonly builtinSkillCount: number
  /** Every bundled Skill pack, so a switch can name what it would add. */
  readonly skillPacks: readonly FreeCodeGoSkillPackStatus[]
  readonly managedSkillRoot?: string
  readonly lastDoctorAt?: number
  readonly lastDoctorOk?: boolean
  readonly councilEngines?: Readonly<Record<'deepseek' | 'codex' | 'claude', { readonly enabled: boolean; readonly available: boolean; readonly reason?: string }>>
}

type EngineeringMemoryTrust = 'captured' | 'draft' | 'reviewed' | 'rejected' | 'superseded'
export interface EngineeringMemoryIndex {
  readonly id: string
  readonly title: string
  readonly kind: string
  readonly trust: EngineeringMemoryTrust
  readonly projectId: string
  readonly createdAt: number
  readonly detailTokens: number
}
interface EngineeringMemoryDetail extends EngineeringMemoryIndex {
  readonly body: string
  readonly tags: readonly string[]
  readonly sourceEngine?: string
}
interface EngineeringMemoryPage {
  readonly records: readonly EngineeringMemoryIndex[]
  readonly nextCursor?: string
}
interface EngineeringMemoryTimeline {
  readonly anchor: EngineeringMemoryIndex
  readonly before: readonly EngineeringMemoryIndex[]
  readonly after: readonly EngineeringMemoryIndex[]
}
interface EngineeringGraphRuntimeStatus {
  readonly state: 'unavailable' | 'ready' | 'installing' | 'error'
  readonly installed: boolean
  readonly version: string
  readonly runtimeDirectory: string
  readonly pythonPath?: string
  readonly wheelDigest?: string
  readonly reason?: string
}
interface EngineeringGraphRuntimePackage {
  readonly id: 'managed-uv-python' | 'existing-python'
  readonly label: string
  readonly detail: string
  readonly compatible: boolean
  readonly requiresPath: boolean
  readonly detectedPath?: string
}
interface EngineeringGraphProjectStatus {
  readonly state: 'unavailable' | 'missing' | 'ready' | 'building' | 'error'
  readonly projectId: string
  readonly graphPath: string
  readonly builtAt?: number
  readonly graphBytes?: number
  readonly reason?: string
}
interface EngineeringCodeGraphRuntimeStatus {
  readonly state: 'unavailable' | 'ready' | 'installing' | 'error'
  readonly installed: boolean
  readonly version: string
  readonly runtimeDirectory: string
  readonly binaryPath?: string
  readonly bundleDigest?: string
  readonly reason?: string
}
interface EngineeringCodeGraphRuntimePackage {
  readonly id: 'managed-bundle'
  readonly label: string
  readonly detail: string
  readonly compatible: boolean
  readonly requiresPath: boolean
}
interface EngineeringCodeGraphProjectStatus {
  readonly state: 'unavailable' | 'missing' | 'ready' | 'building' | 'error'
  readonly projectId: string
  readonly indexPath: string
  readonly builtAt?: number
  readonly indexBytes?: number
  readonly reason?: string
}
interface EngineeringCanvasGraph { readonly projectId: string; readonly generatedAt: number; readonly nodes: readonly { readonly id: string; readonly label: string; readonly kind?: string }[]; readonly edges: readonly { readonly from: string; readonly to: string; readonly kind?: string }[]; readonly truncated: boolean }
interface EngineeringCouncilReport { readonly id: string; readonly sessionId: string; readonly turn: number; readonly provider: string; readonly model: string; readonly createdAt: number; readonly findings: readonly { readonly role: 'architecture' | 'security' | 'testing'; readonly severity: 'nit' | 'concern' | 'blocker'; readonly note: string }[] }
export interface EngineeringTeamDecision { readonly id: string; readonly state: 'approved' | 'rejected'; readonly decidedAt: number; readonly expiresAt?: number }
export interface EngineeringTeamVerificationProbe { readonly id: string; readonly state: string; readonly expectation: 'pass' | 'fail'; readonly rationale: string; readonly held: boolean; readonly summary: string }
export interface EngineeringTeamVerification { readonly id: string; readonly checkedAt: number; readonly stages: readonly { readonly id: string; readonly state: string; readonly durationMs: number; readonly summary: string }[]; readonly probes?: readonly EngineeringTeamVerificationProbe[]; /** Absent on runs recorded before the verdict existed. */ readonly verdict?: 'verified' | 'unverified' | 'failed'; readonly unmet?: readonly string[] }
export interface EngineeringTeamImplementation { readonly id: string; readonly completedAt: number; readonly summary: string; readonly workspaceRevision?: string }
export interface EngineeringTeamReport { readonly id: string; readonly sessionId: string; readonly projectId: string; readonly state: string; readonly createdAt: number; readonly completedAt?: number; readonly objective: string; readonly plan: string; readonly rounds: number; readonly quorum: number; readonly consensus: string; readonly dissent: string; readonly finalRecommendation: string; readonly riskGate?: 'clear' | 'blocked'; readonly blockingFindings?: readonly string[]; readonly findings?: readonly { readonly id: string; readonly engine: string; readonly severity: string; readonly title: string; readonly evidence: string }[]; readonly decision?: EngineeringTeamDecision; readonly implementation?: EngineeringTeamImplementation; readonly verification?: EngineeringTeamVerification; readonly participants: readonly { readonly engine: string; readonly provider: string; readonly model: string; readonly state: string; readonly output?: string; readonly error?: string; readonly durationMs: number }[] }
export interface EngineeringTeamJob { readonly id: string; readonly state: string; readonly sessionId?: string; readonly error?: string; readonly report?: EngineeringTeamReport; readonly decision?: EngineeringTeamDecision; readonly verification?: EngineeringTeamVerification }

/**
 * One line naming what verification found — including what it did not falsify.
 *
 * The probe half is the point: a run whose stages are green because nothing was
 * ever checked reads identically to a run that was actually falsified unless the
 * line says which probes held.
 */
export function engineeringVerificationLine(verification: EngineeringTeamVerification, isZh: boolean): string {
  const stages = verification.stages.map(stage => `${stage.id}:${stage.state}`).join(' · ')
  const probes = verification.probes ?? []
  const probeText = probes.length === 0
    ? (isZh ? '无对抗性探针' : 'no adversarial probe')
    : probes.map(probe => `${probe.id}:${probe.held ? (isZh ? '成立' : 'held') : (isZh ? '未成立' : 'not held')}`).join(' · ')
  const verdict = verification.verdict === undefined ? '' : ` · ${verification.verdict}`
  const reasons = verification.verdict === undefined || verification.verdict === 'verified' ? [] : (verification.unmet ?? []).slice(0, 2)
  return `${stages}${verdict} · ${probeText}${reasons.length === 0 ? '' : ` — ${reasons.join(' ')}`}`
}

export function engineeringTeamState(report: EngineeringTeamReport): string {
  if (report.verification !== undefined) {
    // The recorded verdict decides, because "green stages" is exactly the
    // reading the evidence contract exists to correct: a run with no
    // adversarial probe is unverified, not completed. Results persisted before
    // the verdict existed fall back to the stage scan, with `refused` folded in
    // because a rejected-as-unsafe stage is not a benign gap.
    const verdict = report.verification.verdict
    if (verdict !== undefined) return verdict === 'verified' ? 'completed' : 'blocked'
    return report.verification.stages.some(stage => stage.state === 'fail' || stage.state === 'unavailable' || stage.state === 'cancelled' || stage.state === 'refused') ? 'blocked' : 'completed'
  }
  if (report.decision?.state === 'rejected') return 'rejected'
  if (report.decision?.state === 'approved') return report.decision.expiresAt !== undefined && report.decision.expiresAt < Date.now() ? 'stale' : 'implementing'
  return report.state === 'completed' || report.state === 'partial' ? 'awaiting_approval' : report.state
}

function localizePlanText(value: string | undefined, fallback: string, chinese: boolean): string {
  if (value === undefined || value.trim() === '') return fallback
  if (!chinese) return value
  const credit = /^US\$([0-9]+(?:\.[0-9]+)?) Developer Credit$/i.exec(value.trim())
  if (credit !== null) return `US$${credit[1]} 开发者额度`
  const normalized = value.trim().toLowerCase()
  if (normalized === 'permanent freecodego balance credit') return 'FreeCodeGo 永久开发额度'
  if (normalized === 'never expires') return '余额永久有效'
  if (normalized === 'stacks with future recharges') return '可与后续充值叠加'
  if (normalized.includes('permanent freecodego')) return 'FreeCodeGo 永久开发额度'
  return value
}

function planBenefits(language: 'zh' | 'en'): readonly string[] {
  return language === 'zh' ? ['永久有效', '支持后续叠加充值'] : ['Never expires', 'Stackable balance credit']
}

/** Percent saved against the backend's own list price, or `undefined` when it
 * sent none. Rounded down so the badge never overstates the markdown, and the
 * `> price` guard keeps the ratio from going `NaN` / negative when the two
 * fields disagree. */
function planDiscountPercent(plan: PaymentPlan): number | undefined {
  const price = plan.price
  const original = plan.originalPrice
  if (price === undefined || original === undefined) return undefined
  if (!(price > 0) || !(original > price)) return undefined
  // A markdown that rounds to zero is noise, not a saving, so it is reported as
  // "no discount" and the card keeps its plain price.
  const percent = Math.floor(((original - price) / original) * 100)
  return percent > 0 ? percent : undefined
}

/**
 * The bullets *this* tier declares, and nothing else.
 *
 * Entries go through the same localization pass as plan names, because the
 * backend ships them as display text.
 */
function planFeatures(plan: PaymentPlan, language: 'zh' | 'en'): readonly string[] {
  return (plan.features ?? [])
    .map(feature => localizePlanText(feature, feature, language === 'zh').trim())
    .filter(feature => feature !== '')
}

/** Every bullet one tier shows: its validity line first, then what it declares. */
function planLabels(plan: PaymentPlan, language: 'zh' | 'en'): readonly string[] {
  const validity = planValidityLabel(plan, language)
  return validity === undefined ? planFeatures(plan, language) : [validity, ...planFeatures(plan, language)]
}

/**
 * Split the ladder's bullets into the ones every tier shares and the ones that
 * distinguish a tier.
 *
 * The backend ships the same two or three lines with every credit row ("Never
 * expires", "Stacks with future recharges", "Permanent after purchase"), so
 * rendering each card's own list verbatim printed three identical lines six
 * times and buried the price ladder that is the point of the section. The shared
 * lines belong to the ladder, not to a tier, so they are computed as the
 * intersection and stated once under the grid. Nothing is invented: when a
 * backend declares nothing per tier, the standard pair is still shown on the
 * card, because an empty card reads as a missing offer rather than a plain one.
 */
function splitPlanNotes(plans: readonly PaymentPlan[], language: 'zh' | 'en'): { readonly shared: readonly string[]; readonly own: ReadonlyMap<string, readonly string[]> } {
  const labels = new Map<string, readonly string[]>(plans.map(plan => [String(plan.id), planLabels(plan, language)]))
  const [first, ...rest] = plans
  const shared = first === undefined
    ? []
    : (labels.get(String(first.id)) ?? []).filter(note => rest.every(plan => (labels.get(String(plan.id)) ?? []).includes(note)))
  const own = new Map<string, readonly string[]>()
  for (const plan of plans) {
    const all = labels.get(String(plan.id)) ?? []
    // Only a tier that said *nothing* falls back to the standard pair. A tier
    // whose whole list is shared shows no bullets at all: the row below the grid
    // already states them, and repeating them here is what made the ladder look
    // like filler in the first place.
    own.set(String(plan.id), all.length === 0 ? planBenefits(language) : all.filter(note => !shared.includes(note)))
  }
  return { shared, own }
}

/** Validity as one bullet: the permanent wording, a day count, or `undefined`
 * for a plan that declares neither.
 *
 * The unit is read **before** the day count on purpose. Balance credit is
 * permanent after purchase and the ladder says so with `validityUnit:
 * 'forever'` and no day count, while the backend's `validity_days` column
 * defaults to 30 for a different product shape. Checking `validityDays` first
 * would therefore stamp "30 天" onto permanent credit the moment a plan carries
 * both fields. An unrecognized unit is echoed rather than guessed at. */
function planValidityLabel(plan: PaymentPlan, language: 'zh' | 'en'): string | undefined {
  const zh = language === 'zh'
  const declared = plan.validityUnit?.trim()
  if (declared !== undefined && /^(?:forever|permanent|lifetime|永远|永久)$/iu.test(declared)) {
    return zh ? '购买后永久有效' : 'Permanent after purchase'
  }
  const count = plan.validityDays
  if (count === undefined || !(count > 0)) return undefined
  const unit = declared === undefined || declared === '' ? 'days' : declared
  if (/^days?$/iu.test(unit)) return zh ? `有效期 ${count} 天` : `Valid for ${count} day${count === 1 ? '' : 's'}`
  return zh ? `有效期 ${count} ${unit}` : `Valid for ${count} ${unit}`
}

interface RememberedLogin { readonly email: string; readonly keepSignedIn: boolean }

// Only the email and the keep-signed-in preference may be persisted. Legacy
// payloads that carried a plaintext password are migrated in place to the
// email-only shape and the password is discarded without ever being surfaced to
// the caller.
function readRememberedLogin(): RememberedLogin | undefined {
  if (typeof globalThis.localStorage === 'undefined') return undefined
  let raw: string | null
  try {
    raw = globalThis.localStorage.getItem('freecodego.login.remember')
    if (raw === null) return undefined
    const saved = JSON.parse(raw) as { email?: unknown; password?: unknown; keepSignedIn?: unknown }
    const email = typeof saved.email === 'string' && saved.email.trim() !== '' ? saved.email : undefined
    const legacyPassword = typeof saved.password === 'string' && saved.password !== '' ? saved.password : undefined
    if (email === undefined) return undefined
    if (legacyPassword !== undefined || saved.keepSignedIn === undefined) {
      globalThis.localStorage.removeItem('freecodego.login.remember')
      globalThis.localStorage.setItem('freecodego.login.remember', JSON.stringify({ email, keepSignedIn: true }))
    }
    return { email, keepSignedIn: saved.keepSignedIn !== false }
  } catch (error) {
    throw new Error(`Remembered FreeCodeGo login data is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function clearRememberedLogin(): void {
  if (typeof globalThis.localStorage !== 'undefined') globalThis.localStorage.removeItem('freecodego.login.remember')
}

type AccountAvatarKind = 'qq' | 'google' | 'generic'

function accountAvatarKind(email: string): AccountAvatarKind {
  const domain = email.trim().toLowerCase().split('@').pop() ?? ''
  if (domain === 'qq.com' || domain === 'foxmail.com' || domain.endsWith('.qq.com')) return 'qq'
  if (domain === 'gmail.com' || domain === 'googlemail.com') return 'google'
  return 'generic'
}

function accountProviderLabel(email: string, language: 'zh' | 'en'): string {
  const kind = accountAvatarKind(email)
  if (kind === 'qq') return language === 'zh' ? 'QQ 邮箱账户' : 'QQ Mail account'
  if (kind === 'google') return language === 'zh' ? 'Google 邮箱账户' : 'Google Mail account'
  return language === 'zh' ? '邮箱账户' : 'Email account'
}

function safeAccountAvatarUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const dataUrl = value.trim()
  // Backend-managed avatars may be compressed inline images. Allow only
  // raster base64 data URLs from the validated avatar pipeline; SVG is
  // deliberately excluded because it can carry active markup.
  if (/^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[a-z0-9+/=]+$/i.test(dataUrl)) {
    return dataUrl.length <= 180_000 ? dataUrl : undefined
  }
  try {
    const url = new URL(dataUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    if (url.username !== '' || url.password !== '') return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

function qqNumberFromEmail(email: string): string | undefined {
  const normalized = email.trim().toLowerCase()
  const match = /^(\d{5,20})@(?:qq|foxmail|vip\.qq)\.com$/.exec(normalized)
  return match?.[1]
}

function qqAvatarUrl(email: string): string | undefined {
  const qq = qqNumberFromEmail(email)
  return qq === undefined ? undefined : `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(qq)}&s=160`
}

function AccountAvatar({ email, avatarUrl, language }: { readonly email: string; readonly avatarUrl?: string; readonly language: 'zh' | 'en' }): ReactNode {
  const kind = accountAvatarKind(email)
  const label = accountProviderLabel(email, language)
  const [imageFailed, setImageFailed] = useState(false)
  const remoteAvatar = safeAccountAvatarUrl(avatarUrl) ?? qqAvatarUrl(email)
  if (remoteAvatar !== undefined && !imageFailed) return <span className={`${css.accountAvatar} ${css.accountAvatarRemote}`} role="img" aria-label={label} title={label}><img src={remoteAvatar} alt="" referrerPolicy="no-referrer" onError={() => { setImageFailed(true) }} /></span>
  if (kind === 'qq') return <span className={`${css.accountAvatar} ${css.accountAvatarQq}`} role="img" aria-label={label} title={label}><span className={css.accountAvatarMonogram}>Q</span></span>
  if (kind === 'google') return <span className={`${css.accountAvatar} ${css.accountAvatarGoogle}`} role="img" aria-label={label} title={label}><span className={css.accountAvatarMonogram}>G</span></span>
  return <span className={`${css.accountAvatar} ${css.accountAvatarGeneric}`} role="img" aria-label={label} title={label}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.75 5.5h16.5A1.75 1.75 0 0 1 22 7.25v9.5a1.75 1.75 0 0 1-1.75 1.75H3.75A1.75 1.75 0 0 1 2 16.75v-9.5A1.75 1.75 0 0 1 3.75 5.5Zm.2 2.1 7.1 5.42a1.53 1.53 0 0 0 1.9 0l7.1-5.42H3.95Zm16.05 8.8V9.84l-5.78 4.4a3.52 3.52 0 0 1-4.44 0L4 9.84v6.56c0 .36.29.65.65.65h14.7c.36 0 .65-.29.65-.65Z" /></svg></span>
}

const FREECODEGO_WEB_BASE_URL = 'https://freecodego.com/rootadmin'

interface Injected {
  readonly t: TranslateNS<'settings.freecodego'>
  readonly language: 'zh' | 'en'
  readonly catalog: () => Promise<RemoteResult<Catalog>>
  readonly accountStatus: () => Promise<RemoteResult<AccountState>>
  /**
   * The password this machine remembers for the sign-in form, read once per
   * mount. Optional because the Host owns the value: a build that predates it
   * answers nothing, and the form behaves as if no password was ever kept.
   */
  readonly accountRememberedPassword?: () => Promise<RemoteResult<{ readonly password?: string }>>
  /**
   * `remember` keeps the issued session; `rememberPassword` keeps the password
   * itself in the Host credential file so this form can prefill it next time.
   * They are separate intents, and an explicit `false` on the second erases a
   * password an earlier sign-in stored.
   */
  readonly login: (email: string, password: string, remember?: boolean, rememberPassword?: boolean) => Promise<RemoteResult<AccountState>>
  readonly register?: (input: FreeCodeGoRegistrationRequest) => Promise<RemoteResult<AccountState>>
  readonly sendVerifyCode?: (email: string) => Promise<RemoteResult<{ countdown: number }>>
  /**
   * Password recovery for an account that already exists.
   *
   * Both are optional so a Host that predates them leaves the card's 忘记密码
   * control hidden rather than offering a flow that can only fail.
   */
  readonly forgotPassword?: (email: string) => Promise<RemoteResult<{ sent: true }>>
  readonly resetPassword?: (input: { email: string; verifyCode: string; newPassword: string }) => Promise<RemoteResult<{ reset: true }>>
  /**
   * Federated sign-in (Google / GitHub). The remote exists so the buttons are
   * wired end to end; the Host rejects with `OAUTH_NOT_WIRED` until its
   * provider endpoints land, and the card says so in place.
   */
  readonly oauthLogin?: (provider: FreeCodeGoOAuthProvider) => Promise<RemoteResult<AccountState>>
  /** Pending federated registration surfaced by a browser sign-in that could not auto-link. */
  readonly oauthPendingStatus?: () => Promise<RemoteResult<Record<string, unknown>>>
  readonly oauthPendingSendVerifyCode?: (email: string) => Promise<RemoteResult<{ countdown: number }>>
  readonly oauthPendingBind?: (input: { readonly email: string; readonly password: string; readonly totpCode?: string }) => Promise<RemoteResult<AccountState>>
  readonly oauthPendingCreate?: (input: { readonly email: string; readonly password: string; readonly verifyCode?: string; readonly invitationCode?: string }) => Promise<RemoteResult<AccountState>>
  readonly completeMfa?: (totpCode: string) => Promise<RemoteResult<AccountState>>
  readonly logout: () => Promise<RemoteResult<AccountState>>
  /** Desktop sessions of the signed-in account; the Host owns the bearer token. */
  readonly deviceSessions?: () => Promise<RemoteResult<FreeCodeGoDeviceSessions>>
  readonly revokeDeviceSession?: (deviceId: string) => Promise<RemoteResult<FreeCodeGoDeviceSessions>>
  readonly revokeAllSessions?: () => Promise<RemoteResult<number>>
  readonly setDefaultModel?: (model: string) => Promise<RemoteResult<{ model: string }>>
  readonly setDefaultEngine?: (engine: 'deepseek' | 'codex' | 'claude') => Promise<RemoteResult<{ engine: 'deepseek' | 'codex' | 'claude' }>>
  readonly backendCatalog?: () => Promise<RemoteResult<ManagedCatalog>>
  /** Reads durable media defaults from the native Harness settings document. */
  readonly readMediaDefaults?: () => Promise<{ readonly image: string; readonly video: string; readonly audio: string }>
  /** Generic Harness directory, including user-configured third-party API routes. */
  readonly nativeModelCatalog?: () => Promise<RemoteResult<NativeModelCatalog>>
  /**
   * The rows the chat model picker is rendering right now, flattened.
   *
   * The per-provider visibility controls answer "what does the model list
   * show", so their checklist has to be built from the list itself. This is the
   * client's live session directory — the same snapshot the picker decorator
   * reads — and it is preferred over {@link nativeModelCatalog}, which is the
   * Host's projection and stays empty until a session binds, which is exactly
   * the state a user is in when they open this page to tidy the list.
   */
  readonly pickerModelDirectory?: () => readonly { readonly provider: string; readonly id: string; readonly label: string; readonly description?: string }[]
  readonly vyceStatus?: () => Promise<RemoteResult<FreeCodeGoVyceStatus>>
  readonly vyceSetKey?: (value: string) => Promise<RemoteResult<FreeCodeGoVyceStatus>>
  readonly logfareStatus?: () => Promise<RemoteResult<FreeCodeGoLogfareStatus>>
  readonly logfareRegister?: (input: FreeCodeGoLogfareRegistrationRequest) => Promise<RemoteResult<FreeCodeGoLogfareStatus>>
  readonly logfareSetTrainingOptIn?: (enabled: boolean) => Promise<RemoteResult<FreeCodeGoLogfareStatus>>
  readonly sensenovaStatus?: () => Promise<RemoteResult<FreeCodeGoSenseNovaStatus>>
  readonly sensenovaSetKey?: (value: string) => Promise<RemoteResult<FreeCodeGoSenseNovaStatus>>
  readonly nvidiaStatus?: () => Promise<RemoteResult<FreeCodeGoNvidiaStatus>>
  readonly nvidiaSetKey?: (value: string) => Promise<RemoteResult<FreeCodeGoNvidiaStatus>>
  readonly useConnectionEpoch: SnapshotSelectorHook<number>
  readonly paymentPlans?: () => Promise<RemoteResult<readonly PaymentPlan[]>>
  /** Limits and the publishable Stripe key the in-plugin card form needs. */
  readonly paymentConfig?: () => Promise<RemoteResult<PaymentConfigSnapshot>>
  readonly paymentChannels?: () => Promise<RemoteResult<readonly PaymentChannel[]>>
  readonly gatewayModelPrices?: (language: 'zh' | 'en') => Promise<RemoteResult<readonly GatewayModelPrice[]>>
  readonly paymentOrders?: () => Promise<RemoteResult<unknown>>
  readonly paymentCheckout?: (planId: number, paymentType: string, returnUrl: string, amount?: number) => Promise<RemoteResult<PaymentOrder>>
  readonly paymentOrder?: (orderId: string) => Promise<RemoteResult<PaymentOrder>>
  readonly paymentVerify?: (outTradeNo: string) => Promise<RemoteResult<PaymentOrder>>
  readonly paymentCancel?: (orderId: string) => Promise<RemoteResult<{ readonly cancelled: boolean }>>
  readonly paymentReceiptEmail?: (orderId: string) => Promise<RemoteResult<{ readonly email: string; readonly message?: string }>>
  /** The backend's own receipt file for a paid order, saved as it was issued. */
  readonly paymentReceiptDocument?: (orderId: string) => Promise<RemoteResult<ReceiptDocument>>
  /**
   * Stripe's own receipt for a paid Stripe order, a PDF.
   *
   * Separately declared because it is a different document from a different
   * issuer, and optional like the removal remotes: a Host without it still lists
   * payments and still downloads the receipt the backend draws itself.
   */
  readonly paymentStripeReceiptDocument?: (orderId: string) => Promise<RemoteResult<ReceiptDocument>>
  readonly agnesStatus?: () => Promise<RemoteResult<AgnesStatus>>
  readonly agnesSendVerification?: (email: string) => Promise<RemoteResult<{ readonly sent: boolean }>>
  readonly agnesSendPasswordReset?: (email: string) => Promise<RemoteResult<{ readonly sent: boolean }>>
  readonly agnesResetPassword?: (email: string, password: string, code: string) => Promise<RemoteResult<{ readonly updated: boolean }>>
  readonly agnesLogin?: (email: string, password: string) => Promise<RemoteResult<AgnesStatus>>
  readonly agnesRegister?: (email: string, password: string, code: string) => Promise<RemoteResult<AgnesStatus>>
  readonly agnesCreateApiKey?: (accountId?: string) => Promise<RemoteResult<{ readonly configured: boolean; readonly accountId: string }>>
  readonly agnesRemoveAccount?: (accountId: string) => Promise<RemoteResult<AgnesStatus>>
  readonly agnesRefresh?: (accountId?: string) => Promise<RemoteResult<AgnesStatus>>
  readonly agnesLogout?: (accountId?: string) => Promise<RemoteResult<AgnesStatus>>
  readonly clineStatus?: () => Promise<RemoteResult<ClineStatus>>
  readonly clineStartLogin?: () => Promise<RemoteResult<ClineDeviceLogin>>
  readonly clinePollLogin?: (deviceCode: string) => Promise<RemoteResult<ClineLoginPoll>>
  readonly clineRemoveAccount?: (accountId: string) => Promise<RemoteResult<ClineStatus>>
  readonly clineRefresh?: (accountId?: string) => Promise<RemoteResult<ClineStatus>>
  readonly clineLogout?: () => Promise<RemoteResult<ClineStatus>>
  readonly workbuddyStatus?: () => Promise<RemoteResult<WorkBuddyInternationalStatus>>
  readonly workbuddyImportDesktopLogin?: () => Promise<RemoteResult<WorkBuddyInternationalStatus>>
  readonly workbuddyOpenSignIn?: () => Promise<RemoteResult<{ readonly opened: boolean; readonly url: string }>>
  readonly workbuddyStartBrowserLogin?: () => Promise<RemoteResult<WorkBuddyBrowserLogin>>
  readonly workbuddyPollBrowserLogin?: (state: string) => Promise<RemoteResult<WorkBuddyLoginPoll>>
  readonly workbuddyLogout?: () => Promise<RemoteResult<WorkBuddyInternationalStatus>>
  readonly workbuddyRemoveAccount?: (accountId: string) => Promise<RemoteResult<WorkBuddyInternationalStatus>>
  readonly workbuddySetActiveAccount?: (accountId: string) => Promise<RemoteResult<WorkBuddyInternationalStatus>>
  readonly workbuddyRefreshCredits?: () => Promise<RemoteResult<WorkBuddyInternationalStatus>>
  readonly qoderStatus?: () => Promise<RemoteResult<QoderStatus>>
  readonly qoderStartBrowserLogin?: () => Promise<RemoteResult<QoderBrowserLogin>>
  readonly qoderPollBrowserLogin?: (state: string) => Promise<RemoteResult<QoderLoginPoll>>
  readonly qoderLogout?: () => Promise<RemoteResult<QoderStatus>>
  readonly qoderRemoveAccount?: (accountId: string) => Promise<RemoteResult<QoderStatus>>
  readonly qoderSetActiveAccount?: (accountId: string) => Promise<RemoteResult<QoderStatus>>
  readonly qoderRefreshQuota?: () => Promise<RemoteResult<QoderStatus>>
  readonly qoderCheckin?: () => Promise<RemoteResult<FreeCodeGoCheckinReport>>
  readonly traeStatus?: () => Promise<RemoteResult<TraeStatus>>
  readonly traeStartBrowserLogin?: (realm: 'cn' | 'sg') => Promise<RemoteResult<TraeStatus>>
  readonly traePollBrowserLogin?: () => Promise<RemoteResult<TraeStatus>>
  readonly traeSubmitCallback?: (url: string) => Promise<RemoteResult<TraeStatus>>
  readonly traeCancelBrowserLogin?: () => Promise<RemoteResult<TraeStatus>>
  readonly traeModels?: () => Promise<RemoteResult<readonly TraeModel[]>>
  readonly traeLogout?: () => Promise<RemoteResult<TraeStatus>>
  readonly traeRemoveAccount?: (accountId: string) => Promise<RemoteResult<TraeStatus>>
  readonly traeSetActiveAccount?: (accountId: string) => Promise<RemoteResult<TraeStatus>>
  readonly traeCheckin?: () => Promise<RemoteResult<FreeCodeGoCheckinReport>>

  readonly codexRuntimeStatus?: () => Promise<RemoteResult<{ readonly installed: boolean; readonly platform: string; readonly runtimeVersion?: string; readonly artifactDigest?: string; readonly reason?: string }>>
  readonly codexRuntimePackages?: () => Promise<RemoteResult<readonly RuntimePackage[]>>
  readonly codexRuntimeInstall?: (packageID?: string) => Promise<RemoteResult<{ readonly installed: boolean; readonly platform: string; readonly runtimeVersion?: string; readonly artifactDigest?: string; readonly reason?: string }>>
  readonly codexRuntimeRemove?: () => Promise<RemoteResult<{ readonly installed: boolean; readonly platform: string; readonly runtimeVersion?: string; readonly artifactDigest?: string; readonly reason?: string }>>
  readonly claudeRuntimeStatus?: () => Promise<RemoteResult<{ readonly installed: boolean; readonly platform: string; readonly runtimeVersion?: string; readonly artifactDigest?: string; readonly reason?: string }>>
  readonly claudeRuntimePackages?: () => Promise<RemoteResult<readonly RuntimePackage[]>>
  readonly claudeRuntimeInstall?: (packageID?: string) => Promise<RemoteResult<{ readonly installed: boolean; readonly platform: string; readonly runtimeVersion?: string; readonly artifactDigest?: string; readonly reason?: string }>>
  readonly claudeRuntimeRemove?: () => Promise<RemoteResult<{ readonly installed: boolean; readonly platform: string; readonly runtimeVersion?: string; readonly artifactDigest?: string; readonly reason?: string }>>
  readonly communityCatalog: () => Promise<RemoteResult<{ readonly updated?: string; readonly plugins: readonly { readonly name: string; readonly owner: string; readonly url: string; readonly category: string | readonly string[]; readonly iconUrl?: string; readonly screenshots?: readonly string[]; readonly description?: { readonly zh?: string; readonly en?: string }; readonly npm?: string; readonly stars?: number; readonly downloads?: number; readonly added?: string }[] }>>
  readonly communityCatalogIcons?: ((urls: readonly string[]) => Promise<RemoteResult<Readonly<Record<string, string>>>>) | undefined
  readonly communityEnvironment: () => Promise<RemoteResult<{ readonly ready: boolean; readonly platform: string; readonly node: string; readonly profile: string }>>
  readonly communityInstalled: () => Promise<RemoteResult<{ readonly installed: Record<string, string>; readonly activation: Record<string, { readonly state: string }>; readonly sources?: Record<string, readonly string[]>; readonly restartRequired?: boolean }>>
  readonly communityInstall: (url: string) => Promise<RemoteResult<{ readonly ok: true; readonly packageNames: readonly string[]; readonly restartRequired: true }>>
  readonly communityUninstall?: (url: string) => Promise<RemoteResult<{ readonly ok: true; readonly packageNames: readonly string[]; readonly restartRequired: true }>>
  readonly capabilityMarketplace?: (input: { readonly kind: 'mcp' | 'skill'; readonly query?: string; readonly category?: string; readonly offset?: number; readonly limit?: number }) => Promise<RemoteResult<{ readonly kind: 'mcp' | 'skill'; readonly total: number; readonly offset: number; readonly limit: number; readonly query?: string; readonly categories: readonly { readonly id: string; readonly label: string; readonly count?: number }[]; readonly items: readonly { readonly id: string; readonly kind: 'mcp' | 'skill'; readonly title: string; readonly description: string; readonly category: string; readonly sourceUrl: string; readonly iconUrl?: string; readonly author?: string; readonly popularity: number; readonly installed: boolean; readonly installable: boolean; readonly requiresConfiguration?: boolean }[] }>>
  readonly mcpPresetInstall?: (id: string) => Promise<RemoteResult<CapabilitySnapshot>>
  readonly skillPresetInstall?: (id: string, placement?: FreeCodeGoSkillPlacement) => Promise<RemoteResult<CapabilitySnapshot>>
  readonly skillPresetRemove?: (id: string) => Promise<RemoteResult<CapabilitySnapshot>>
  /** The Skill placement matrix, optional: a Host without it installs to the community root. */
  readonly skillPlacements?: () => Promise<RemoteResult<FreeCodeGoSkillPlacements>>
  /** Remember the chosen Skill destination, or clear it when no axes are named. */
  readonly skillPlacementPrefer?: (placement?: FreeCodeGoSkillPlacement) => Promise<RemoteResult<CapabilitySnapshot>>
  readonly capabilities?: () => Promise<RemoteResult<CapabilitySnapshot>>
  readonly readLocalCapabilities?: () => Promise<{ readonly voiceInputEnabled: boolean; readonly sessionDeleteEnabled: boolean }>
  readonly capabilitiesSetEnabled?: (input: { readonly mcpEnabled?: boolean; readonly skillEnabled?: boolean; readonly voiceInputEnabled?: boolean; readonly sessionDeleteEnabled?: boolean }) => Promise<RemoteResult<CapabilitySnapshot>>
  /** Direct native Settings write used for local UI switches when older Remote descriptors are present. */
  readonly setLocalCapability?: (key: 'voiceInputEnabled' | 'sessionDeleteEnabled', value: boolean) => Promise<void>
  readonly setModelCategoryDirect?: (key: string, category: ModelCategory) => Promise<void>
  readonly modelCategorySet?: (input: { readonly key: string; readonly category?: ModelCategory }) => Promise<RemoteResult<CapabilitySnapshot>>
  readonly pluginConflictStatus?: () => Promise<RemoteResult<FreeCodeGoPluginConflictStatus>>
  readonly pluginConflictSetEnabled?: (enabled: boolean) => Promise<RemoteResult<FreeCodeGoPluginConflictStatus>>
  readonly headroomStatus?: () => Promise<RemoteResult<HeadroomStats>>
  readonly headroomSetEnabled?: (enabled: boolean) => Promise<RemoteResult<HeadroomStats>>
  readonly headroomUpdate?: (patch: { readonly thresholdChars?: number; readonly minSavingsRatio?: number; readonly dedupEnabled?: boolean; readonly excludeTools?: readonly string[]; readonly foldReads?: boolean; readonly codeSkeletonEnabled?: boolean; readonly foldPolicy?: 'reversible' | 'max' }) => Promise<RemoteResult<HeadroomStats>>
  readonly deferredToolsStatus?: () => Promise<RemoteResult<DeferredToolStatus>>
  readonly deferredToolsSetEnabled?: (enabled: boolean) => Promise<RemoteResult<DeferredToolStatus>>
  readonly mediaGenerationStatus?: () => Promise<RemoteResult<FreeCodeGoMediaToolStatus>>
  readonly mediaGenerationSetEnabled?: (enabled: boolean) => Promise<RemoteResult<FreeCodeGoMediaToolStatus>>
  /**
   * The code review surface.
   *
   * The three calls take the session id because a review is about the workspace
   * the user is in: the Host resolves the working directory from the session, so a
   * panel cannot ask about a checkout the session never opened. `reviewStart` is
   * fire-and-forget in the Host and returns the runs as they stand, which is why the
   * panel polls `reviewStatus` while a run is in flight.
   */
  readonly reviewStatus?: (sessionId: string) => Promise<RemoteResult<FreeCodeGoReviewStatus>>
  readonly reviewStart?: (sessionId: string, request: FreeCodeGoReviewStartRequest) => Promise<RemoteResult<FreeCodeGoReviewStatus>>
  readonly reviewUpdate?: (sessionId: string, patch: FreeCodeGoReviewUpdate) => Promise<RemoteResult<FreeCodeGoReviewStatus>>
  readonly guardSettingsStatus?: () => Promise<RemoteResult<FreeCodeGoGuardSettingsStatus>>
  readonly guardSettingsUpdate?: (patch: FreeCodeGoGuardSettingsUpdate) => Promise<RemoteResult<FreeCodeGoGuardSettingsStatus>>
  readonly automationSettingsStatus?: () => Promise<RemoteResult<FreeCodeGoAutomationSettings>>
  readonly automationSettingsUpdate?: (patch: FreeCodeGoAutomationSettingsUpdate) => Promise<RemoteResult<FreeCodeGoAutomationSettings>>
  readonly sandboxModeStatus?: (sessionId: string) => Promise<RemoteResult<FreeCodeGoSandboxStatus>>
  readonly sandboxModeSet?: (sessionId: string, mode: FreeCodeGoSandboxMode) => Promise<RemoteResult<FreeCodeGoSandboxStatus>>
  /**
   * Folder trust: which repositories this workspace may load content from.
   *
   * Status is called with no argument because the Host answers about the
   * workspace it runs in; grant and revoke are handed the canonical root that
   * status reported, so the panel never derives a repository root itself.
   */
  readonly trustFolderStatus?: () => Promise<RemoteResult<FreeCodeGoTrustStatus>>
  readonly trustFolderGrant?: (directory: string) => Promise<RemoteResult<FreeCodeGoTrustStatus>>
  readonly trustFolderRevoke?: (directory: string) => Promise<RemoteResult<FreeCodeGoTrustStatus>>
  readonly projectConfigReport?: (workspaceRoot?: string) => Promise<RemoteResult<ProjectConfigReport>>
  readonly pluginUpdateStatus?: () => Promise<RemoteResult<FreeCodeGoPluginUpdateStatus>>
  readonly pluginUpdateCheck?: () => Promise<RemoteResult<FreeCodeGoPluginUpdateStatus>>
  readonly pluginUpdateSetEnabled?: (enabled: boolean) => Promise<RemoteResult<FreeCodeGoPluginUpdateStatus>>
  readonly pluginUpdateInstall?: () => Promise<RemoteResult<FreeCodeGoPluginUpdateStatus>>
  readonly pluginUpdateRollback?: () => Promise<RemoteResult<FreeCodeGoPluginUpdateStatus>>
  readonly mcpSave?: (input: Omit<CapabilityMcpServer, 'id'> & { readonly id?: string }) => Promise<RemoteResult<CapabilitySnapshot>>
  readonly mcpRemove?: (id: string) => Promise<RemoteResult<CapabilitySnapshot>>
  readonly skillRootSave?: (input: Omit<CapabilitySkillRoot, 'id'> & { readonly id?: string }) => Promise<RemoteResult<CapabilitySnapshot>>
  readonly skillRootRemove?: (id: string) => Promise<RemoteResult<CapabilitySnapshot>>
  /** Set or clear one Skill's model-invocation override. */
  readonly skillInvocationSet?: (input: { readonly name: string; readonly modelInvocable?: boolean }) => Promise<RemoteResult<CapabilitySnapshot>>
  /**
   * Read one Skill's body, or one of its companion files, for the library dialog.
   *
   * Declared here rather than taken from the generated Remote surface: the
   * descriptor only exists once the Host bundle is rebuilt, and the page has to
   * compile against an older Host without it (`skillDetail` is optional, and the
   * card explains itself instead of failing when it is absent).
   */
  readonly skillDetail?: (input: { readonly name: string; readonly file?: string }) => Promise<RemoteResult<CapabilitySkillDetail>>
  readonly advisorStatus?: () => Promise<RemoteResult<AdvisorSnapshot>>
  readonly advisorUpdate?: (input: AdvisorUpdate) => Promise<RemoteResult<AdvisorSnapshot>>
  readonly advisorReviewNow?: (sessionId: string) => Promise<RemoteResult<AdvisorSnapshot>>
  readonly engineeringEval?: () => Promise<RemoteResult<FreeCodeGoEngineeringEvalReport>>
  readonly engineeringMemorySearch?: (sessionId: string, searchText?: string, limit?: number) => Promise<RemoteResult<readonly EngineeringMemoryIndex[]>>
  readonly engineeringMemoryRecall?: (sessionId: string) => Promise<RemoteResult<FreeCodeGoEngineeringMemoryRecall>>
  readonly engineeringSkillDraft?: (sessionId: string) => Promise<RemoteResult<FreeCodeGoEngineeringSkillDraftResult>>
  readonly engineeringSpecExport?: (sessionId: string, request: { readonly id: string }) => Promise<RemoteResult<FreeCodeGoEngineeringSpecBundle>>
  readonly logfareSetKey?: (value: string) => Promise<RemoteResult<FreeCodeGoLogfareStatus>>
  readonly accountDetail?: () => Promise<RemoteResult<FreeCodeGoBackendSnapshot>>
  readonly clineAddAccount?: (refreshToken: string) => Promise<RemoteResult<ClineStatus>>
  readonly advisorModels?: () => Promise<RemoteResult<readonly AdvisorModelChoice[]>>
  readonly advisorNotes?: () => Promise<RemoteResult<readonly AdvisorNote[]>>
  readonly engineeringStatus?: () => Promise<RemoteResult<EngineeringStatus>>
  readonly engineeringSetEnabled?: (enabled: boolean) => Promise<RemoteResult<EngineeringStatus>>
  readonly engineeringSettingsUpdate?: (input: Partial<EngineeringSettings>) => Promise<RemoteResult<EngineeringStatus>>
  readonly engineeringLoopStatus?: (sessionId: string) => Promise<RemoteResult<EngineeringLoopStatus>>
  readonly engineeringLoopArm?: (sessionId: string) => Promise<RemoteResult<EngineeringLoopStatus>>
  readonly engineeringLoopStop?: (sessionId: string) => Promise<RemoteResult<EngineeringLoopStatus>>
  readonly engineeringCouncilReview?: (sessionId: string) => Promise<RemoteResult<{ readonly id: string; readonly findings: readonly { readonly role: string; readonly severity: string; readonly note: string }[] }>>
  readonly engineeringCouncilReports?: (sessionId: string) => Promise<RemoteResult<readonly EngineeringCouncilReport[]>>
  readonly engineeringTeamStart?: (sessionId: string, request: { readonly objective: string; readonly plan: string; readonly constraints?: readonly string[]; readonly engines?: readonly ('deepseek' | 'codex' | 'claude')[]; readonly maxRounds?: number; readonly run_in_background?: boolean }) => Promise<RemoteResult<EngineeringTeamJob>>
  readonly engineeringTeamJob?: (id: string) => Promise<RemoteResult<EngineeringTeamJob>>
  readonly engineeringTeamCancel?: (id: string) => Promise<RemoteResult<EngineeringTeamJob>>
  readonly engineeringTeamReports?: (sessionId: string) => Promise<RemoteResult<readonly EngineeringTeamReport[]>>
  readonly engineeringTeamDecision?: (sessionId: string, request: { readonly id: string; readonly decision: 'approved' | 'rejected' }) => Promise<RemoteResult<EngineeringTeamDecision>>
  readonly engineeringTeamVerify?: (sessionId: string, request: { readonly id: string; readonly stages?: readonly ('scope' | 'build' | 'types' | 'lint' | 'tests')[] }) => Promise<RemoteResult<EngineeringTeamVerification>>
  readonly engineeringTeamImplementation?: (sessionId: string, request: { readonly id: string; readonly summary: string }) => Promise<RemoteResult<EngineeringTeamImplementation>>
  readonly engineeringMemoryList?: (sessionId: string, request?: { readonly trusts?: readonly EngineeringMemoryTrust[]; readonly limit?: number; readonly cursor?: string }) => Promise<RemoteResult<EngineeringMemoryPage>>
  readonly engineeringMemoryTimeline?: (sessionId: string, request: { readonly id: string; readonly before?: number; readonly after?: number }) => Promise<RemoteResult<EngineeringMemoryTimeline>>
  readonly engineeringMemoryGet?: (sessionId: string, ids: readonly string[]) => Promise<RemoteResult<readonly EngineeringMemoryDetail[]>>
  readonly engineeringMemoryReview?: (sessionId: string, request: { readonly id: string; readonly decision: 'reviewed' | 'rejected' | 'superseded' }) => Promise<RemoteResult<EngineeringMemoryDetail>>
  readonly engineeringMemoryDelete?: (sessionId: string, id: string) => Promise<RemoteResult<{ readonly deleted: true }>>
  readonly engineeringMemoryPurgeProject?: (sessionId: string, request?: { readonly includeReviewed?: boolean }) => Promise<RemoteResult<{ readonly deleted: number }>>
  readonly engineeringMemoryExport?: (sessionId: string) => Promise<RemoteResult<{ readonly version: 1; readonly exportedAt: number; readonly projectId: string; readonly records: readonly EngineeringMemoryDetail[] }>>
  readonly engineeringMemoryBackup?: (sessionId: string) => Promise<RemoteResult<{ readonly id: string; readonly createdAt: number; readonly bytes: number }>>
  readonly engineeringMemoryRetentionSweep?: (sessionId: string, retentionDays?: number) => Promise<RemoteResult<{ readonly retentionDays: number; readonly deletedMemories: number; readonly deletedOutboxEntries: number }>>
  readonly engineeringMemoryConsolidate?: (sessionId: string) => Promise<RemoteResult<MemoryConsolidation>>
  readonly engineeringMemoryManifest?: (sessionId: string) => Promise<RemoteResult<MemoryManifest>>
  readonly engineeringGraphRuntimeStatus?: () => Promise<RemoteResult<EngineeringGraphRuntimeStatus>>
  readonly engineeringGraphRuntimePackages?: () => Promise<RemoteResult<readonly EngineeringGraphRuntimePackage[]>>
  readonly engineeringGraphRuntimeInstall?: (input: { readonly packageId: 'managed-uv-python' | 'existing-python'; readonly pythonPath?: string }) => Promise<RemoteResult<EngineeringGraphRuntimeStatus>>
  readonly engineeringGraphRuntimeRemove?: () => Promise<RemoteResult<EngineeringGraphRuntimeStatus>>
  readonly engineeringGraphProjectStatus?: (sessionId: string) => Promise<RemoteResult<EngineeringGraphProjectStatus>>
  readonly engineeringGraphBuild?: (sessionId: string, request?: { readonly force?: boolean }) => Promise<RemoteResult<EngineeringGraphProjectStatus>>
  readonly engineeringGraphUpdate?: (sessionId: string) => Promise<RemoteResult<EngineeringGraphProjectStatus>>
  readonly engineeringGraphCancel?: (sessionId: string) => Promise<RemoteResult<{ readonly cancelled: boolean }>>
  readonly engineeringGraphCanvas?: (sessionId: string, request?: { readonly maxNodes?: number }) => Promise<RemoteResult<EngineeringCanvasGraph>>
  readonly engineeringGraphClearProject?: (sessionId: string) => Promise<RemoteResult<EngineeringGraphProjectStatus>>
  readonly engineeringCodeGraphRuntimeStatus?: () => Promise<RemoteResult<EngineeringCodeGraphRuntimeStatus>>
  readonly engineeringCodeGraphRuntimePackages?: () => Promise<RemoteResult<readonly EngineeringCodeGraphRuntimePackage[]>>
  readonly engineeringCodeGraphRuntimeInstall?: () => Promise<RemoteResult<EngineeringCodeGraphRuntimeStatus>>
  readonly engineeringCodeGraphRuntimeRemove?: () => Promise<RemoteResult<EngineeringCodeGraphRuntimeStatus>>
  readonly engineeringCodeGraphProjectStatus?: (sessionId: string) => Promise<RemoteResult<EngineeringCodeGraphProjectStatus>>
  readonly engineeringCodeGraphBuild?: (sessionId: string, request?: { readonly force?: boolean }) => Promise<RemoteResult<EngineeringCodeGraphProjectStatus>>
  readonly engineeringCodeGraphSync?: (sessionId: string) => Promise<RemoteResult<EngineeringCodeGraphProjectStatus>>
  readonly engineeringCodeGraphCancel?: (sessionId: string) => Promise<RemoteResult<{ readonly cancelled: boolean }>>
  readonly engineeringCodeGraphClearProject?: (sessionId: string) => Promise<RemoteResult<EngineeringCodeGraphProjectStatus>>
  readonly engineeringCheckpointList?: (sessionId: string) => Promise<RemoteResult<readonly EngineeringCheckpoint[]>>
  readonly engineeringCheckpointCapture?: (sessionId: string, input: { readonly label: string }) => Promise<RemoteResult<EngineeringCheckpoint>>
  readonly engineeringCheckpointDiff?: (sessionId: string, input: { readonly id: string }) => Promise<RemoteResult<EngineeringCheckpointDiff>>
  readonly engineeringCheckpointRestore?: (sessionId: string, input: { readonly id: string }) => Promise<RemoteResult<EngineeringCheckpointRestoreResult>>
  readonly engineeringCheckpointRemove?: (sessionId: string, input: { readonly id: string }) => Promise<RemoteResult<{ readonly deleted: true }>>
  readonly engineeringCheckpointSetPinned?: (sessionId: string, input: { readonly id: string; readonly pinned: boolean }) => Promise<RemoteResult<{ readonly pinned: boolean }>>
  /** The unified loaded-surface report, the third door onto the same collection pass as the tool and the command. */
  readonly inspectReport?: () => Promise<RemoteResult<FreeCodeGoInspectReport>>
  /** The numbered plan under review, with its section warnings. */
  readonly planReviewOpen?: (sessionId: string) => Promise<RemoteResult<FreeCodeGoPlanReviewSurface>>
  /**
   * Line-level remarks turned into the rework message.
   *
   * A rejection is a *successful* call that carries `rejected` rather than a
   * `RemoteError`: the Host refuses an unusable submission without failing, and
   * a panel that read only `result.ok` would show the refusal as a compose that
   * silently produced nothing.
   */
  readonly planReviewCompose?: (request: FreeCodeGoPlanReviewRequest) => Promise<RemoteResult<{ readonly message?: string; readonly rejected?: string }>>
  readonly currentSessionId?: () => string | undefined
}

type Props = PropsRuntime<'settings.section'> & PropsLocale<'settings.freecodego'> & InjectFace<Injected>

type SettingsBoundaryState = { readonly error?: Error }

/** Keep one incompatible optional Remote or provider panel from rendering the entire settings section blank. */
export class FreeCodeGoSettingsBoundary extends Component<Props, SettingsBoundaryState> {
  override state: SettingsBoundaryState = {}

  static getDerivedStateFromError(error: unknown): SettingsBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: Error): void {
    console.error('FreeCodeGo settings section render failed:', error)
  }

  override render(): ReactNode {
    const error = this.state.error
    if (error === undefined) return <FreeCodeGoSettingsTab {...this.props} />
    const retry = (): void => { this.setState({}) }
    return <section className={css.root} aria-live="polite">
      <header className={css.toolbar}>
        <div className={css.toolbarTitle}><div className={css.kicker}>FreeCodeGo</div><h2 className={css.title}>{this.props.t('title')}</h2></div>
      </header>
      <div className={css.alert} role="alert">
        {this.props.language === 'zh' ? 'FreeCodeGo 设置页面加载失败。' : 'The FreeCodeGo settings page failed to load.'}
        <br />{error.message}
      </div>
      <button className={css.button} type="button" onClick={retry}>{this.props.language === 'zh' ? '重试加载' : 'Retry loading'}</button>
    </section>
  }
}

/** Cordis slot wrapper preserving the full injected-props inference contract. */
export function FreeCodeGoSettingsSection(props: Props): ReactNode {
  return <FreeCodeGoSettingsBoundary {...props} />
}

export const CAPABILITY_CHANGE_EVENT = 'freecodego:capability-change'
export const ADVISOR_CHANGE_EVENT = 'freecodego:advisor-change'
export const ENGINEERING_CHANGE_EVENT = 'freecodego:engineering-change'
const CONFLICT_NOTICE_MAX_AGE_MS = 10 * 60_000

function publishCapabilitySnapshot(snapshot: CapabilitySnapshot): void {
  globalThis.dispatchEvent(new CustomEvent<CapabilitySnapshot>(CAPABILITY_CHANGE_EVENT, { detail: snapshot }))
}

function publishAdvisorSnapshot(snapshot: AdvisorSnapshot): void {
  globalThis.dispatchEvent(new CustomEvent<AdvisorSnapshot>(ADVISOR_CHANGE_EVENT, { detail: snapshot }))
}

function publishEngineeringSnapshot(snapshot: EngineeringStatus): void {
  globalThis.dispatchEvent(new CustomEvent<EngineeringStatus>(ENGINEERING_CHANGE_EVENT, { detail: snapshot }))
}

export interface CapabilitySectionInjected {
  readonly capabilities: NonNullable<Injected['capabilities']>
  readonly mcpSave: NonNullable<Injected['mcpSave']>
  readonly mcpRemove: NonNullable<Injected['mcpRemove']>
  readonly capabilityMarketplace: NonNullable<Injected['capabilityMarketplace']>
  readonly mcpPresetInstall: NonNullable<Injected['mcpPresetInstall']>
  readonly skillRootSave: NonNullable<Injected['skillRootSave']>
  readonly skillRootRemove: NonNullable<Injected['skillRootRemove']>
  readonly skillInvocationSet?: NonNullable<Injected['skillInvocationSet']>
  /** On-demand Skill body and companion files for the library dialog. */
  readonly skillDetail: NonNullable<Injected['skillDetail']>
  /** Bundled Skill packs and their switches, so the library can name what is off. */
  readonly engineeringStatus: NonNullable<Injected['engineeringStatus']>
  readonly engineeringSettingsUpdate: NonNullable<Injected['engineeringSettingsUpdate']>
  /** Skill drafting is Skill-page only; the MCP page leaves both absent. */
  readonly engineeringSkillDraft?: NonNullable<Injected['engineeringSkillDraft']>
  readonly currentSessionId?: NonNullable<Injected['currentSessionId']>
  /** Active UI language, so the capability pages follow the language switch. */
  readonly language: 'zh' | 'en'
}

export interface AdvisorSectionInjected {
  readonly advisorStatus: NonNullable<Injected['advisorStatus']>
  readonly advisorUpdate: NonNullable<Injected['advisorUpdate']>
  readonly advisorModels: NonNullable<Injected['advisorModels']>
  readonly advisorNotes: NonNullable<Injected['advisorNotes']>
  readonly advisorReviewNow: NonNullable<Injected['advisorReviewNow']>
  readonly currentSessionId: NonNullable<Injected['currentSessionId']>
}

export interface EngineeringSectionInjected {
  readonly engineeringStatus: NonNullable<Injected['engineeringStatus']>
  readonly engineeringSetEnabled: NonNullable<Injected['engineeringSetEnabled']>
  readonly engineeringSettingsUpdate: NonNullable<Injected['engineeringSettingsUpdate']>
  readonly engineeringLoopStatus?: NonNullable<Injected['engineeringLoopStatus']>
  readonly engineeringLoopArm?: NonNullable<Injected['engineeringLoopArm']>
  readonly engineeringLoopStop?: NonNullable<Injected['engineeringLoopStop']>
  readonly engineeringCouncilReview: NonNullable<Injected['engineeringCouncilReview']>
  readonly engineeringCouncilReports: NonNullable<Injected['engineeringCouncilReports']>
  readonly engineeringTeamStart?: NonNullable<Injected['engineeringTeamStart']>
  readonly engineeringTeamJob?: NonNullable<Injected['engineeringTeamJob']>
  readonly engineeringTeamCancel?: NonNullable<Injected['engineeringTeamCancel']>
  readonly engineeringTeamReports?: NonNullable<Injected['engineeringTeamReports']>
  readonly engineeringTeamDecision?: NonNullable<Injected['engineeringTeamDecision']>
  readonly engineeringTeamVerify?: NonNullable<Injected['engineeringTeamVerify']>
  readonly engineeringTeamImplementation?: NonNullable<Injected['engineeringTeamImplementation']>
  readonly engineeringMemoryList: NonNullable<Injected['engineeringMemoryList']>
  readonly engineeringMemorySearch: NonNullable<Injected['engineeringMemorySearch']>
  readonly engineeringMemoryRecall: NonNullable<Injected['engineeringMemoryRecall']>
  readonly engineeringSpecExport: NonNullable<Injected['engineeringSpecExport']>
  readonly engineeringEval: NonNullable<Injected['engineeringEval']>
  readonly engineeringMemoryTimeline: NonNullable<Injected['engineeringMemoryTimeline']>
  readonly engineeringMemoryGet: NonNullable<Injected['engineeringMemoryGet']>
  readonly engineeringMemoryReview: NonNullable<Injected['engineeringMemoryReview']>
  readonly engineeringMemoryDelete: NonNullable<Injected['engineeringMemoryDelete']>
  readonly engineeringMemoryPurgeProject: NonNullable<Injected['engineeringMemoryPurgeProject']>
  readonly engineeringMemoryExport: NonNullable<Injected['engineeringMemoryExport']>
  readonly engineeringMemoryBackup: NonNullable<Injected['engineeringMemoryBackup']>
  readonly engineeringMemoryRetentionSweep: NonNullable<Injected['engineeringMemoryRetentionSweep']>
  readonly engineeringMemoryConsolidate: NonNullable<Injected['engineeringMemoryConsolidate']>
  readonly engineeringMemoryManifest: NonNullable<Injected['engineeringMemoryManifest']>
  readonly engineeringGraphRuntimeStatus: NonNullable<Injected['engineeringGraphRuntimeStatus']>
  readonly engineeringGraphRuntimePackages: NonNullable<Injected['engineeringGraphRuntimePackages']>
  readonly engineeringGraphRuntimeInstall: NonNullable<Injected['engineeringGraphRuntimeInstall']>
  readonly engineeringGraphRuntimeRemove: NonNullable<Injected['engineeringGraphRuntimeRemove']>
  readonly engineeringGraphProjectStatus: NonNullable<Injected['engineeringGraphProjectStatus']>
  readonly engineeringGraphBuild: NonNullable<Injected['engineeringGraphBuild']>
  readonly engineeringGraphUpdate: NonNullable<Injected['engineeringGraphUpdate']>
  readonly engineeringGraphCancel: NonNullable<Injected['engineeringGraphCancel']>
  readonly engineeringGraphCanvas: NonNullable<Injected['engineeringGraphCanvas']>
  readonly engineeringGraphClearProject: NonNullable<Injected['engineeringGraphClearProject']>
  readonly engineeringCodeGraphRuntimeStatus: NonNullable<Injected['engineeringCodeGraphRuntimeStatus']>
  readonly engineeringCodeGraphRuntimePackages: NonNullable<Injected['engineeringCodeGraphRuntimePackages']>
  readonly engineeringCodeGraphRuntimeInstall: NonNullable<Injected['engineeringCodeGraphRuntimeInstall']>
  readonly engineeringCodeGraphRuntimeRemove: NonNullable<Injected['engineeringCodeGraphRuntimeRemove']>
  readonly engineeringCodeGraphProjectStatus: NonNullable<Injected['engineeringCodeGraphProjectStatus']>
  readonly engineeringCodeGraphBuild: NonNullable<Injected['engineeringCodeGraphBuild']>
  readonly engineeringCodeGraphSync: NonNullable<Injected['engineeringCodeGraphSync']>
  readonly engineeringCodeGraphCancel: NonNullable<Injected['engineeringCodeGraphCancel']>
  readonly engineeringCodeGraphClearProject: NonNullable<Injected['engineeringCodeGraphClearProject']>
  readonly engineeringCheckpointList: NonNullable<Injected['engineeringCheckpointList']>
  readonly engineeringCheckpointCapture: NonNullable<Injected['engineeringCheckpointCapture']>
  readonly engineeringCheckpointDiff: NonNullable<Injected['engineeringCheckpointDiff']>
  readonly engineeringCheckpointRestore: NonNullable<Injected['engineeringCheckpointRestore']>
  readonly engineeringCheckpointRemove: NonNullable<Injected['engineeringCheckpointRemove']>
  readonly engineeringCheckpointSetPinned: NonNullable<Injected['engineeringCheckpointSetPinned']>
  /** Read-only: the same report `engineering_inspect` and `/inspect` answer from. */
  readonly inspectReport: NonNullable<Injected['inspectReport']>
  readonly planReviewOpen: NonNullable<Injected['planReviewOpen']>
  readonly planReviewCompose: NonNullable<Injected['planReviewCompose']>
  readonly currentSessionId: NonNullable<Injected['currentSessionId']>
}

type CapabilitySectionProps = PropsRuntime<'settings.section'> & InjectFace<CapabilitySectionInjected>
type AdvisorSectionProps = PropsRuntime<'settings.section'> & InjectFace<AdvisorSectionInjected>
type EngineeringSectionProps = PropsRuntime<'settings.section'> & InjectFace<EngineeringSectionInjected>

function PluginUpdateSettings(input: {
  readonly status?: FreeCodeGoPluginUpdateStatus | undefined
  readonly check?: (() => Promise<RemoteResult<FreeCodeGoPluginUpdateStatus>>) | undefined
  readonly setEnabled?: ((enabled: boolean) => Promise<RemoteResult<FreeCodeGoPluginUpdateStatus>>) | undefined
  readonly install?: (() => Promise<RemoteResult<FreeCodeGoPluginUpdateStatus>>) | undefined
  readonly rollback?: (() => Promise<RemoteResult<FreeCodeGoPluginUpdateStatus>>) | undefined
  readonly language: 'zh' | 'en'
}): ReactNode {
  const [status, setStatus] = useState<FreeCodeGoPluginUpdateStatus | undefined>(input.status)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const text = input.language === 'zh'
    ? { title: 'FreeCodeGo 更新', enabled: '已开启', disabled: '已关闭', localDetail: '当前使用本地构建。重新构建并重启 Harness 后会自动同步，无需从发布源下载。', releaseDetail: '插件只跟随 Harness 基线更新：先读取当前 Profile 的 Harness 版本，再从发布源挑选同一 Harness 行的 Release，安装时复用 dsh plugin 命令。', switchTitle: '自动检查更新', switchHint: '关闭后不会访问发布源，但仍可手动检查。', switchAria: '自动检查 FreeCodeGo 更新', source: '更新来源', rollback: '恢复上一版本', unknownVersion: '当前版本未知', restart: '重启后生效', local: '本地构建已同步', available: (version: string) => `发现适配版本 ${version}`, current: '已是最新适配版本', incompatible: '没有匹配当前 Harness 的插件版本', failed: (reason: string) => `检查失败：${reason}`, installing: '正在安装更新…', idle: '尚未检查', working: '处理中…', check: '立即检查', install: '下载并安装', unknownError: '未知错误' }
    : { title: 'FreeCodeGo updates', enabled: 'Enabled', disabled: 'Disabled', localDetail: 'This installation uses a local build. Rebuild and restart Harness to synchronize it; no download from the release source is required.', releaseDetail: 'Updates follow the Harness baseline only: the active profile version is detected first, then a Release on the same Harness line is selected from the release source and installed through the dsh plugin command.', switchTitle: 'Automatically check for updates', switchHint: 'Disabling this prevents release-source access, but manual checks remain available.', switchAria: 'Automatically check for FreeCodeGo updates', source: 'Update source', rollback: 'Restore previous version', unknownVersion: 'Current version unknown', restart: 'Takes effect after restart', local: 'Local build synchronized', available: (version: string) => `Matching version available: ${version}`, current: 'Up to date (compatible with this Harness)', incompatible: 'No plugin version matches this Harness build', failed: (reason: string) => `Check failed: ${reason}`, installing: 'Installing update…', idle: 'Not checked yet', working: 'Working…', check: 'Check now', install: 'Download and install', unknownError: 'Unknown error' }
  useEffect(() => { setStatus(input.status) }, [input.status])
  const run = (operation: (() => Promise<RemoteResult<FreeCodeGoPluginUpdateStatus>>) | undefined): void => {
    if (operation === undefined || busy) return
    setBusy(true); setError(undefined)
    void operation().then((result) => {
      if (result.ok) setStatus(result.value)
      else setError(result.error.message)
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const updateEnabled = (enabled: boolean): void => {
    if (input.setEnabled === undefined || busy) return
    setBusy(true); setError(undefined)
    void input.setEnabled(enabled).then((result) => {
      if (result.ok) setStatus(result.value)
      else setError(result.error.message)
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const enabled = status?.enabled !== false
  const phaseLabel = status?.installation === 'local'
    ? text.local
    : status?.phase === 'available'
      ? text.available(status.latestVersion ?? '')
      : status?.phase === 'up-to-date' ? text.current
        : status?.phase === 'incompatible' ? text.incompatible
          : status?.phase === 'error' ? text.failed(status.error ?? text.unknownError)
            : status?.phase === 'installing' ? text.installing : text.idle
  return <section className={css.section}>
    <div className={css.sectionHeader}><div><div className={css.kicker}>UPDATES</div><strong className={css.sectionName}>{text.title}</strong></div><span className={`${css.badge} ${enabled ? css.badgeLive : ''}`}>{enabled ? text.enabled : text.disabled}</span></div>
    <small className={css.sectionMeta}>{status?.installation === 'local' ? text.localDetail : text.releaseDetail}</small>
    {error === undefined ? null : <div className={css.alert} role="alert">{error}</div>}
    <div className={css.extensionList}>
      <label className={css.extensionRow}><span><strong>{text.switchTitle}</strong><small>{text.switchHint}</small></span><input className={css.switch} aria-label={text.switchAria} type="checkbox" checked={enabled} onChange={(event) => { updateEnabled(event.target.checked) }} disabled={input.setEnabled === undefined || busy} /></label>
      {status?.installation === 'release' ? <div className={css.infoCell}><div className={css.routingCopy}><small className={css.cellLabel}>{text.source}</small></div><strong>{status.releaseRepository}</strong></div> : null}
    </div>
    <div className={css.accountActions}><small className={css.sectionMeta}>{status?.currentVersion ?? text.unknownVersion}{status?.harnessVersion ? ` · Harness ${status.harnessVersion}` : ''} · {phaseLabel}{status?.restartRequired ? ` · ${text.restart}` : ''}</small><button className={css.button} type="button" onClick={() => { run(input.check) }} disabled={input.check === undefined || busy}>{busy ? text.working : text.check}</button>{status?.phase === 'available' ? <button className={`${css.button} ${css.buttonPrimary}`} type="button" onClick={() => { run(input.install) }} disabled={input.install === undefined || busy}>{text.install}</button> : null}{status?.rollbackPending === true ? <button className={css.button} type="button" onClick={() => { run(input.rollback) }} disabled={input.rollback === undefined || busy}>{text.rollback}</button> : null}</div>
  </section>
}

function useCapabilitySnapshot(load: CapabilitySectionInjected['capabilities']): {
  readonly snapshot: CapabilitySnapshot | undefined
  readonly error: string | undefined
  readonly setSnapshot: (value: CapabilitySnapshot) => void
  readonly setError: (value: string | undefined) => void
} {
  const [snapshot, setSnapshot] = useState<CapabilitySnapshot | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  useEffect(() => {
    let active = true
    void load().then((result) => {
      if (!active) return
      if (result.ok) setSnapshot(result.value)
      else setError(result.error.message)
    }, (reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { active = false }
  }, [load])
  return { snapshot, error, setSnapshot, setError }
}

/** Monotonic request ownership used to prevent late async responses from mutating current UI state. */
export function createRequestEpochGate(): { readonly begin: () => () => boolean; readonly invalidate: () => void } {
  let generation = 0
  return {
    begin: () => {
      const request = ++generation
      return () => request === generation
    },
    invalidate: () => { generation += 1 },
  }
}

/** Ignore an older request after a refresh, session switch, or component disposal. */
function useLatestRequestGuard(): () => () => boolean {
  const gate = useRef<ReturnType<typeof createRequestEpochGate> | undefined>(undefined)
  if (gate.current === undefined) gate.current = createRequestEpochGate()
  useEffect(() => () => { gate.current?.invalidate() }, [])
  return () => gate.current!.begin()
}

function isWorkspaceContextError(value: unknown): boolean {
  const record = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as { readonly message?: unknown } : undefined
  const message = value instanceof Error ? value.message : typeof value === 'string' ? value : typeof record?.message === 'string' ? record.message : ''
  return /engineering memory requires an open workspace-backed conversation/i.test(message)
}

/** Dedicated settings-sidebar page for enabled MCP management. */
export function McpSettingsSection({ capabilities, mcpSave, mcpRemove, capabilityMarketplace, mcpPresetInstall, language }: CapabilitySectionProps): ReactNode {
  const state = useCapabilitySnapshot(capabilities)
  return <>{state.error === undefined ? null : <div className={css.alert} role="alert">MCP 配置读取失败：{state.error}</div>}<McpCapabilityPage snapshot={state.snapshot} save={mcpSave} remove={mcpRemove} marketplace={capabilityMarketplace} installMarketplace={mcpPresetInstall} onSnapshot={state.setSnapshot} onError={state.setError} language={language} /></>
}

/** Dedicated settings-sidebar page for enabled Skill management. */
/** The publish pre-flight's report, as the draft result carries it. */
type SkillPublishReport = FreeCodeGoEngineeringSkillDraftResult['drafts'][number]['preflight']

/**
 * What the publish pre-flight found, in the row's own words.
 *
 * Failures are named rather than counted: the draft is a file the user is about to
 * move into a Skill root, so "3 problems" is not something they can act on, while
 * the sentence the check wrote is. A draft the check refused says so in the same
 * line, which is the point of running it while the user is still looking at the
 * draft rather than at a publish button.
 */
function skillPublishNote(report: SkillPublishReport): string {
  const failures = report.findings.filter(finding => finding.severity === 'error').length
  const size = `约 ${String(report.tokens)} 标记，上限 ${String(report.limitTokens)}`
  if (report.findings.length === 0) return `发布前检查通过（${size}）`
  const parts = report.findings.map(finding => `${finding.severity === 'error' ? '必须修' : '建议修'}：${finding.message}`)
  return `发布前检查发现 ${String(report.findings.length)} 项（${String(failures)} 项必须修；${size}）— ${parts.join('；')}`
}

export function SkillSettingsSection({ capabilities, skillRootSave, skillRootRemove, skillInvocationSet, skillDetail, engineeringStatus, engineeringSettingsUpdate, engineeringSkillDraft, currentSessionId, language }: CapabilitySectionProps): ReactNode {
  const state = useCapabilitySnapshot(capabilities)
  const [packs, setPacks] = useState<readonly FreeCodeGoSkillPackStatus[] | undefined>(undefined)
  const [packBusy, setPackBusy] = useState(false)
  const [draft, setDraft] = useState<FreeCodeGoEngineeringSkillDraftResult | undefined>(undefined)
  const [draftBusy, setDraftBusy] = useState(false)
  useEffect(() => {
    let active = true
    void engineeringStatus().then((result) => { if (active && result.ok) setPacks(result.value.skillPacks) }, () => {
      // The pack line is optional chrome: a Host that cannot report the packs
      // leaves the library without it rather than failing the page.
    })
    return () => { active = false }
  }, [engineeringStatus])
  const enablePacks = (ids: readonly FreeCodeGoSkillPackStatus['id'][]): void => {
    if (packBusy || ids.length === 0) return
    setPackBusy(true)
    // Each pack switch sits under the pack-wide switch, so enabling a pack turns
    // that one on too. Persisting the inner switch alone would store a setting
    // whose effect nothing can observe and leave the hint on screen. All the off
    // packs are enabled in one write: two writes would both start from the same
    // settings revision and the second would undo the first.
    const patch: Partial<EngineeringSettings> = {
      engineeringEnabled: true,
      ...ids.includes('starter') ? { engineeringStarterSkillsEnabled: true } : {},
      ...ids.includes('engineering') ? { engineeringSkillsEnabled: true } : {},
      ...ids.includes('superpowers') ? { engineeringSuperpowersSkillsEnabled: true } : {},
    }
    void engineeringSettingsUpdate(patch).then((result) => {
      if (!result.ok) { state.setError(result.error.message); return }
      setPacks(result.value.skillPacks)
      // The pack's provider just mounted, so the library has to be re-read: the
      // new Skills are discovered by the Host, not by this page.
      void capabilities().then((refreshed) => { if (refreshed.ok) state.setSnapshot(refreshed.value) }, () => {})
    }, (reason: unknown) => { state.setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setPackBusy(false) })
  }
  /**
   * Distil this session's repeated procedures into draft Skill files.
   *
   * The Host has had this Remote since the Skill pack work landed and nothing
   * could start it, so the only path to a draft was the model deciding to write
   * one by hand. Drafts are written to the workspace for review and are never
   * auto-mounted, which is why the copy says so.
   */
  const draftSkills = (): void => {
    const sessionId = currentSessionId?.()
    if (draftBusy) return
    if (sessionId === undefined) { state.setError('先打开一个绑定工作区的会话，再提炼 Skill 草稿。'); return }
    if (engineeringSkillDraft === undefined) return
    setDraftBusy(true)
    void engineeringSkillDraft(sessionId).then((result) => {
      if (!result.ok) { state.setError(result.error.message); return }
      setDraft(result.value)
    }, (reason: unknown) => { state.setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setDraftBusy(false) })
  }
  return <>{state.error === undefined ? null : <div className={css.alert} role="alert">Skill 配置读取失败：{state.error}</div>}<SkillCapabilityPage snapshot={state.snapshot} save={skillRootSave} remove={skillRootRemove} skillInvocationSet={skillInvocationSet} detail={skillDetail} packs={packs} onEnablePacks={enablePacks} packBusy={packBusy} onSnapshot={state.setSnapshot} onError={state.setError} language={language} />{engineeringSkillDraft === undefined ? null : <section className={css.section}>
    <div className={css.sectionHeader}><div><div className={css.kicker}>SKILL DRAFTS</div><strong className={css.sectionName}>从本会话提炼技能</strong></div><button className={css.button} type="button" onClick={draftSkills} disabled={draftBusy}>{draftBusy ? '提炼中…' : '提炼草稿'}</button></div>
    <small className={css.sectionMeta}>把本会话里反复出现的做法整理成 Skill 草稿文件，写在项目目录下供你审阅。草稿不会自动挂载，也不会改变 AI 的行为。</small>
    {draft === undefined ? null : draft.drafts.length === 0
      ? <small className={css.sectionMeta} role="status">{draft.reason ?? '本次没有聚类出足够大的做法，未生成草稿。'}</small>
      : <div className={css.extensionList}>{draft.drafts.map(item => <div className={css.extensionRow} key={item.name}><span><strong>{item.name}</strong><small>来自 {item.sources} 条会话证据</small><small>{skillPublishNote(item.preflight)}</small></span></div>)}</div>}
    {draft?.directory === undefined ? null : <small className={css.sectionMeta}>草稿目录：{draft.directory}</small>}
  </section>}</>
}

/** Dedicated settings-sidebar page for the optional Host-owned Advisor. */
export function AdvisorSettingsSection({ advisorStatus, advisorUpdate, advisorModels, advisorNotes, advisorReviewNow, currentSessionId }: AdvisorSectionProps): ReactNode {
  const [snapshot, setSnapshot] = useState<AdvisorSnapshot | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [reviewNote, setReviewNote] = useState<string | undefined>(undefined)
  useEffect(() => {
    let active = true
    void advisorStatus().then((result) => {
      if (!active) return
      if (result.ok) setSnapshot(result.value)
      else setError(result.error.message)
    }, (reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { active = false }
  }, [advisorStatus])
  /**
   * Review the current session on demand.
   *
   * The panel has always shown the backoff line as "manual review is unaffected",
   * and nothing could trigger one: after a run of failures the automatic path
   * sits out several turns, so the only way to check whether the route recovered
   * was to wait for it. This is that missing action.
   */
  const reviewNow = (): void => {
    const sessionId = currentSessionId()
    if (reviewBusy) return
    if (sessionId === undefined) { setReviewNote('先在左侧打开一个会话，再手动复核。'); return }
    setReviewBusy(true)
    setReviewNote(undefined)
    void advisorReviewNow(sessionId).then((result) => {
      if (result.ok) {
        setSnapshot(result.value)
        publishAdvisorSnapshot(result.value)
        setReviewNote('已触发；建议会在复核完成后出现在下方「最近建议」。')
      } else setError(result.error.message)
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setReviewBusy(false) })
  }
  return <>{error === undefined ? null : <div className={css.alert} role="alert">Advisor 状态读取失败：{error}</div>}<AdvisorSettingsPage snapshot={snapshot} update={advisorUpdate} models={advisorModels} onSnapshot={(next) => { setSnapshot(next); publishAdvisorSnapshot(next) }} onError={setError} onReview={reviewNow} reviewBusy={reviewBusy} reviewNote={reviewNote} standalone /><AdvisorNotesPanel load={advisorNotes} /></>
}

function engineeringMemoryDate(value: number): string {
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(value) } catch { return new Date(value).toLocaleString() }
}

export function EngineeringMemoryPanel(input: {
  readonly enabled: boolean
  readonly currentSessionId: () => string | undefined
  readonly list: EngineeringSectionInjected['engineeringMemoryList']
  readonly timeline: EngineeringSectionInjected['engineeringMemoryTimeline']
  readonly get: EngineeringSectionInjected['engineeringMemoryGet']
  readonly review: EngineeringSectionInjected['engineeringMemoryReview']
  readonly remove: EngineeringSectionInjected['engineeringMemoryDelete']
  readonly purge: EngineeringSectionInjected['engineeringMemoryPurgeProject']
  readonly exportReviewed: EngineeringSectionInjected['engineeringMemoryExport']
  readonly backup: EngineeringSectionInjected['engineeringMemoryBackup']
  readonly retentionSweep: EngineeringSectionInjected['engineeringMemoryRetentionSweep']
  /**
   * Ranked text search over the same store the list reads page 1 of.
   *
   * Optional because a Host from before this Remote exists still renders the
   * panel: the search row is hidden rather than shown as a box whose button
   * throws. `recall` follows the same rule for the same reason.
   */
  readonly search?: EngineeringSectionInjected['engineeringMemorySearch'] | undefined
  /** Preview the bounded index that is injected at session start. */
  readonly recall?: EngineeringSectionInjected['engineeringMemoryRecall'] | undefined
  /**
   * Force one consolidation pass, and rebuild the curated index, from the panel.
   *
   * Both answer a question the rest of this panel cannot: the list below shows
   * the engineering-memory store, while these two drive the curated topic
   * archive that a session start injects. The pass normally runs on a debounce
   * after a turn, so without a gesture a user who just turned the stage up has
   * no way to see its effect, and a topic edited by hand has no way back into
   * the index short of spending a model request.
   */
  readonly consolidate: EngineeringSectionInjected['engineeringMemoryConsolidate']
  readonly manifest: EngineeringSectionInjected['engineeringMemoryManifest']
}): ReactNode {
  const [records, setRecords] = useState<readonly EngineeringMemoryIndex[]>([])
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<readonly EngineeringMemoryIndex[] | undefined>(undefined)
  const [blurb, setBlurb] = useState<FreeCodeGoEngineeringMemoryRecall | undefined>(undefined)
  const [blurbClosed, setBlurbClosed] = useState(false)
  const [selected, setSelected] = useState<EngineeringMemoryDetail | undefined>(undefined)
  const [timeline, setTimeline] = useState<EngineeringMemoryTimeline | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [workspaceUnavailable, setWorkspaceUnavailable] = useState(false)
  const [maintenance, setMaintenance] = useState<string | undefined>(undefined)
  /**
   * The curated index the last rebuild rendered, kept so the user can read what
   * a session start would inject as pointers. Held separately from `maintenance`
   * because it is content, not a status line, and it survives the next action.
   */
  const [manifestIndex, setManifestIndex] = useState<string | undefined>(undefined)
  const beginRequest = useLatestRequestGuard()
  const load = (): void => {
    const isCurrent = beginRequest()
    const sessionId = input.currentSessionId()
    if (!input.enabled) { if (isCurrent()) { setRecords([]); setSelected(undefined); setTimeline(undefined); setWorkspaceUnavailable(false) }; return }
    if (sessionId === undefined) { if (isCurrent()) { setRecords([]); setSelected(undefined); setTimeline(undefined); setError(undefined); setWorkspaceUnavailable(true); setBusy(false) }; return }
    setWorkspaceUnavailable(false)
    setBusy(true)
    setError(undefined)
    void input.list(sessionId, { trusts: ['captured', 'draft', 'reviewed'], limit: 60 }).then((result) => {
      if (!isCurrent()) return
      if (!result.ok) { if (isWorkspaceContextError(result.error.message)) { setRecords([]); setSelected(undefined); setTimeline(undefined); setWorkspaceUnavailable(true); setError(undefined) } else setError(result.error.message); return }
      setRecords(result.value.records)
    }, (reason: unknown) => { if (isCurrent()) { if (isWorkspaceContextError(reason)) { setRecords([]); setSelected(undefined); setTimeline(undefined); setWorkspaceUnavailable(true); setError(undefined) } else setError(reason instanceof Error ? reason.message : String(reason)) } }).finally(() => { if (isCurrent()) setBusy(false) })
  }
  useEffect(() => { load() }, [input.enabled, input.list, input.currentSessionId])
  /**
   * Show what a session start would inject, not what the store holds.
   *
   * These are different questions and the panel used to answer only the second:
   * the list shows every captured and draft record, while the model only ever
   * receives the reviewed ones that fit the injection budget. A user deciding
   * whether to approve a draft needs to see which side of that line it is on.
   */
  useEffect(() => {
    // The preview is the first thing to go when the Host does not expose the
    // remote: the panel keeps listing records rather than failing to render.
    if (!input.enabled || input.recall === undefined) { setBlurb(undefined); return }
    const sessionId = input.currentSessionId()
    if (sessionId === undefined) { setBlurb(undefined); return }
    let active = true
    void input.recall(sessionId).then((result) => {
      if (!active) return
      // A workspace-context failure is already reported by the list above; the
      // preview stays absent rather than repeating the same error twice.
      setBlurb(result.ok ? result.value : undefined)
    }, () => { if (active) setBlurb(undefined) })
    return () => { active = false }
  }, [input.enabled, input.recall, input.currentSessionId, records])
  const runSearch = (): void => {
    const sessionId = input.currentSessionId()
    const text = query.trim()
    if (sessionId === undefined || busy || input.search === undefined) return
    // An empty box means "stop filtering", not "search for nothing": the Remote
    // answers an absent query with an unfiltered page, which would look like the
    // search returned everything.
    if (text === '') { setSearchResults(undefined); return }
    setBusy(true)
    setError(undefined)
    void input.search(sessionId, text, 20).then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      setSearchResults(result.value)
      setSelected(undefined)
      setTimeline(undefined)
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const visible = searchResults ?? records
  const inspect = (id: string): void => {
    const sessionId = input.currentSessionId()
    if (sessionId === undefined || busy) return
    const isCurrent = beginRequest()
    setBusy(true)
    setError(undefined)
    void Promise.all([input.get(sessionId, [id]), input.timeline(sessionId, { id })]).then(([detailResult, timelineResult]) => {
      if (!isCurrent()) return
      if (!detailResult.ok) { setError(detailResult.error.message); return }
      setSelected(detailResult.value[0])
      if (timelineResult.ok) setTimeline(timelineResult.value)
      else setTimeline(undefined)
    }, (reason: unknown) => { if (isCurrent()) setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { if (isCurrent()) setBusy(false) })
  }
  const review = (id: string, decision: 'reviewed' | 'rejected'): void => {
    const sessionId = input.currentSessionId()
    if (sessionId === undefined || busy) return
    setBusy(true)
    void input.review(sessionId, { id, decision }).then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      if (selected?.id === id) setSelected(result.value)
      load()
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const remove = (id: string): void => {
    const sessionId = input.currentSessionId()
    if (sessionId === undefined || busy) return
    if (typeof globalThis.confirm === 'function' && !globalThis.confirm('永久删除这条工程记忆？此操作无法撤销。')) return
    setBusy(true)
    void input.remove(sessionId, id).then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      if (selected?.id === id) { setSelected(undefined); setTimeline(undefined) }
      load()
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const purge = (): void => {
    const sessionId = input.currentSessionId()
    if (sessionId === undefined || busy) return
    if (typeof globalThis.confirm === 'function' && !globalThis.confirm('清空当前项目的全部长期记忆？此操作无法撤销。')) return
    setBusy(true)
    void input.purge(sessionId, { includeReviewed: true }).then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      setSelected(undefined); setTimeline(undefined); load()
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const backup = (): void => {
    const sessionId = input.currentSessionId()
    if (sessionId === undefined || busy) return
    setBusy(true); setError(undefined)
    void input.backup(sessionId).then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      setMaintenance(`已创建一致性备份 · ${Math.ceil(result.value.bytes / 1024)} KiB`)
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const retentionSweep = (): void => {
    const sessionId = input.currentSessionId()
    if (sessionId === undefined || busy) return
    setBusy(true); setError(undefined)
    void input.retentionSweep(sessionId, 90).then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      setMaintenance(`已清理 ${result.value.deletedMemories} 条过期记忆记录和 ${result.value.deletedOutboxEntries} 条待处理记录；长期项目知识已保留。`)
      load()
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const exportReviewed = (): void => {
    const sessionId = input.currentSessionId()
    if (sessionId === undefined || busy) return
    setBusy(true)
    void input.exportReviewed(sessionId).then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      const content = JSON.stringify(result.value, null, 2)
      const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `freecodego-engineering-memory-${result.value.projectId}.json`
      anchor.click()
      URL.revokeObjectURL(url)
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  /**
   * Run one consolidation pass now.
   *
   * The result is reported field by field rather than as a bare "done", because
   * the informative outcomes are the quiet ones: a stage that has not been
   * turned up reports `skipped`, and a pass that planned topics but committed
   * none reports `completed` with a `problem` naming the stage. Collapsing those
   * into a success message is exactly the state a user cannot debug.
   */
  const consolidate = (): void => {
    const sessionId = input.currentSessionId()
    if (sessionId === undefined || busy) return
    setBusy(true); setError(undefined); setMaintenance(undefined)
    void input.consolidate(sessionId).then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      const { outcome, stage, observations, topicsWritten, durationMs, problem } = result.value
      setMaintenance(`整合 ${outcome} · 阶段 ${stage} · 读取 ${observations} 条观察 · 写入 ${topicsWritten} 个主题 · 耗时 ${durationMs} ms${problem === undefined ? '' : ` · ${problem}`}`)
      load()
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  /**
   * Rebuild the curated `MEMORY.md` index from the topics on disk.
   *
   * `omitted` and `truncated` are surfaced because a silent omission would read
   * as "these are all the records", which is the one wrong answer the budget
   * exists to avoid. Nothing is dropped by this: the files stay where they are,
   * and the index says so in its own overflow notice.
   */
  const rebuildManifest = (): void => {
    const sessionId = input.currentSessionId()
    if (sessionId === undefined || busy) return
    setBusy(true); setError(undefined); setMaintenance(undefined)
    void input.manifest(sessionId).then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      const { markdown, included, omitted, truncated } = result.value
      setManifestIndex(markdown)
      setMaintenance(`已重建长期记忆索引 · 收录 ${included} 条${omitted === 0 ? '' : ` · 预算内省略 ${omitted} 条（文件仍在磁盘上）`}${truncated ? ' · 索引已截断' : ''}`)
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  return <section className={css.memoryPanel}>
    <header className={css.engineeringHeader}><div><div className={css.engineeringKicker}>PROJECT MEMORY</div><strong>项目长期记忆</strong><small>跨会话保存项目决策、修复结果和关键上下文。</small></div><div className={css.memoryActions}><button className={css.button} type="button" onClick={load} disabled={!input.enabled || busy}>刷新</button><details className={css.actionMenu}><summary className={css.button}>管理</summary><div className={css.actionMenuPop}><button className={css.button} type="button" onClick={consolidate} disabled={!input.enabled || busy}>立即整合</button><button className={css.button} type="button" onClick={rebuildManifest} disabled={!input.enabled || busy}>重建记忆索引</button><button className={css.button} type="button" onClick={exportReviewed} disabled={!input.enabled || busy}>导出长期记忆</button><button className={css.button} type="button" onClick={backup} disabled={!input.enabled || busy}>创建备份</button><button className={css.button} type="button" onClick={retentionSweep} disabled={!input.enabled || busy}>清理过期内容</button><button className={`${css.button} ${css.buttonDanger}`} type="button" onClick={purge} disabled={!input.enabled || busy}>清空项目记忆</button></div></details></div></header>
    {error === undefined ? null : <div className={css.alert} role="alert">工程记忆操作失败：{error}</div>}
    {maintenance === undefined ? null : <small className={css.sectionMeta} role="status">{maintenance}</small>}
    {manifestIndex === undefined ? null : <div className={css.memoryRecall}>
      <div className={css.memoryRecallHead}><strong>长期记忆索引（MEMORY.md）</strong><small>会话开始时注入的指针列表；每条内容仍留在它自己的文件里。</small><button className={css.button} type="button" onClick={() => { setManifestIndex(undefined) }}>收起</button></div>
      <pre className={css.diagnosticsDump}>{manifestIndex}</pre>
    </div>}
    {input.enabled && !workspaceUnavailable && records.length > 0 ? <div className={css.engineeringSummary}><span><b>{records.length}</b> 条项目记忆</span><span><b>{records.filter(record => record.trust === 'draft' || record.trust === 'captured').length}</b> 条待审核</span><span>最近 {engineeringMemoryDate(records[0]!.createdAt)}</span></div> : null}
    {!input.enabled || input.search === undefined || workspaceUnavailable || input.currentSessionId() === undefined ? null : <div className={css.memorySearchRow}>
      <input className={css.input} value={query} aria-label="搜索项目记忆" placeholder="按关键词搜索项目记忆" onChange={(event) => { setQuery(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter') runSearch() }} disabled={busy} />
      <button className={css.button} type="button" onClick={runSearch} disabled={busy}>{busy ? '搜索中…' : '搜索'}</button>
      {searchResults === undefined ? null : <button className={css.button} type="button" onClick={() => { setQuery(''); setSearchResults(undefined) }} disabled={busy}>清除搜索</button>}
    </div>}
    {blurb === undefined || blurbClosed || !input.enabled || workspaceUnavailable ? null : <div className={css.memoryRecall} role="status">
      <div className={css.memoryRecallHead}><strong>会话开始时注入的记忆</strong><small>{blurb.records.length} 条已审核记忆，占 {blurb.usedTokens} / {blurb.tokenBudget} tokens（只有「已审核」会进入这里）</small><button className={css.button} type="button" onClick={() => { setBlurbClosed(true) }}>收起</button></div>
      {blurb.records.length === 0 ? <small className={css.sectionMeta}>当前没有已审核记忆，因此新会话不会注入任何项目知识。</small> : <div className={css.memoryRecallList}>{blurb.records.map(record => <span key={record.id}>{record.title}</span>)}</div>}
    </div>}
    {searchResults === undefined ? null : <small className={css.sectionMeta} role="status">搜索「{query.trim()}」命中 {searchResults.length} 条（最多 20 条）。</small>}
    {!input.enabled ? <div className={css.emptyCapability}><strong>项目长期记忆未启用</strong><small>开启后 AI 会在本地保存并复用项目知识。</small></div> : workspaceUnavailable || input.currentSessionId() === undefined ? <div className={css.emptyCapability}><strong>打开工作区对话后查看长期记忆</strong><small>长期记忆按项目隔离；打开一个绑定工作区的对话后，AI 才能继续记录和读取。</small></div> : visible.length === 0 ? <div className={css.emptyCapability}><strong>{searchResults === undefined ? 'AI 还没有记录项目记忆' : '没有匹配的项目记忆'}</strong><small>{searchResults === undefined ? '完成一次有实际变更的对话后，系统会自动整理并保存可复用的项目知识。' : '换一个关键词，或清除搜索回到全部记录。'}</small></div> : <div className={css.memoryList}>{visible.map(record => <article key={record.id} className={`${css.memoryRecord} ${selected?.id === record.id ? css.memoryRecordSelected : ''}`}><button className={css.memoryRecordSelect} type="button" onClick={() => { inspect(record.id) }} disabled={busy}><span><strong>{record.title}</strong><small>{record.kind} · {engineeringMemoryDate(record.createdAt)} · 约 {record.detailTokens} tokens</small></span><span className={`${css.memoryTrust} ${record.trust === 'reviewed' ? css.memoryTrustReviewed : record.trust === 'draft' ? css.memoryTrustDraft : ''}`}>{record.trust === 'reviewed' ? '已审核' : record.trust === 'draft' ? '待审核' : '已捕获'}</span></button><div className={css.memoryRecordActions}><button className={css.button} type="button" onClick={() => { remove(record.id) }} disabled={busy}>删除</button></div></article>)}</div>}
    {selected === undefined ? null : <article className={css.memoryDetail}><div className={css.memoryDetailHeader}><div><strong>{selected.title}</strong><small>{selected.kind}{selected.sourceEngine === undefined ? '' : ` · ${selected.sourceEngine}`}</small></div><div>{selected.trust === 'draft' || selected.trust === 'captured' ? <><button className={css.button} type="button" onClick={() => { review(selected.id, 'reviewed') }} disabled={busy}>通过并纳入长期记忆</button><button className={css.button} type="button" onClick={() => { review(selected.id, 'rejected') }} disabled={busy}>拒绝</button></> : null}<button className={css.button} type="button" onClick={() => { remove(selected.id) }} disabled={busy}>删除</button></div></div><p>{selected.body}</p>{selected.tags.length === 0 ? null : <div className={css.memoryTags}>{selected.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}{timeline === undefined ? null : <div className={css.memoryTimeline}><strong>相关时间线</strong>{[...timeline.before, timeline.anchor, ...timeline.after].map(item => <button key={item.id} className={item.id === selected.id ? css.memoryTimelineCurrent : ''} type="button" onClick={() => { inspect(item.id) }} disabled={busy}>{engineeringMemoryDate(item.createdAt)} · {item.title}</button>)}</div>}</article>}
  </section>
}

/**
 * Workspace checkpoints (Cline-style shadow snapshots) as a browseable
 * timeline.
 *
 * The Host has owned capture/list/diff/restore/pin/remove Remotes for a while,
 * but the Web UI had no surface for any of them — a checkpoint could only be
 * reached by the model through its tools. This panel is that missing surface.
 *
 * Restore is destructive, so the flow is deliberately two-step: selecting a
 * checkpoint shows its diff first, and only the diff view carries the restore
 * action. Restoring is confirmed again at the click, because a restore rewrites
 * workspace files and deletes files created after the snapshot.
 */
/**
 * The plugin's own deterministic self-check, started from the surface.
 *
 * The suite exists to be run — guards, memory, headroom, media and parsers — and
 * until now only the test runner could start it, so a user had no way to answer
 * "is this build's logic still sound?" after an update. The report keeps
 * `observed` / `required` so a marginal pass is distinguishable from a
 * comfortable one, and only failures are listed: a passing case needs no row to
 * say so.
 */
export function EngineeringEvalPanel(input: {
  readonly run: EngineeringSectionInjected['engineeringEval']
}): ReactNode {
  const [report, setReport] = useState<FreeCodeGoEngineeringEvalReport | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const start = (): void => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    void input.run().then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      setReport(result.value)
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const failures = report === undefined ? [] : report.cases.filter(item => !item.passed)
  return <section className={css.graphPanel}>
    <div className={css.memoryHeader}><div><strong>插件自检</strong><small>在本地跑一遍插件自己的确定性检查（{report === undefined ? '命令策略、长期记忆、上下文压缩、媒体链路、解析器' : `${report.suites.length} 个领域、${report.total} 项`}），确认升级后逻辑仍然成立。不会修改任何设置或文件。</small></div><div className={css.accountActions}>{report === undefined ? null : <span className={`${css.badge} ${report.ok ? css.badgeLive : css.badgeDanger}`}>{report.passed}/{report.total} 通过</span>}<button className={css.button} type="button" onClick={start} disabled={busy}>{busy ? '自检中…' : report === undefined ? '运行自检' : '重新运行'}</button></div></div>
    {error === undefined ? null : <div className={css.alert} role="alert">自检未能完成：{error}</div>}
    {report === undefined ? null : <>
      <small className={css.sectionMeta} role="status">{report.ok ? '全部通过。' : `有 ${failures.length} 项未达阈值，下面写明各自缺什么。`}检查时间 {new Date(report.checkedAt).toLocaleString()}。</small>
      {failures.map(item => <div className={css.accountRow} key={item.id}><div className={css.accountIdentity}><strong>{item.claim}</strong><small>{item.suite} · 实测 {item.observed} / 需要 {item.required}{item.failure === undefined ? '' : ` · ${item.failure}`}</small></div><span className={`${css.badge} ${css.badgeDanger}`}>未通过</span></div>)}
    </>}
  </section>
}

export function EngineeringCheckpointPanel(input: {
  readonly enabled: boolean
  /** Why the checkpoint store is not available, straight from the Host module. */
  readonly detail?: string | undefined
  readonly currentSessionId: () => string | undefined
  readonly list: EngineeringSectionInjected['engineeringCheckpointList']
  readonly capture: EngineeringSectionInjected['engineeringCheckpointCapture']
  readonly diff: EngineeringSectionInjected['engineeringCheckpointDiff']
  readonly restore: EngineeringSectionInjected['engineeringCheckpointRestore']
  readonly remove: EngineeringSectionInjected['engineeringCheckpointRemove']
  readonly setPinned: EngineeringSectionInjected['engineeringCheckpointSetPinned']
}): ReactNode {
  const [checkpoints, setCheckpoints] = useState<readonly EngineeringCheckpoint[]>([])
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [preview, setPreview] = useState<EngineeringCheckpointDiff | undefined>(undefined)
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [workspaceUnavailable, setWorkspaceUnavailable] = useState(false)
  const beginRequest = useLatestRequestGuard()
  // The panel must tolerate a Host that predates these Remotes. Without this
  // guard an absent Remote would be invoked as a function during the mount
  // effect, and the thrown TypeError would abort every later effect in the
  // settings tab — producing unrelated failures far from the real cause.
  const wired = input.list !== undefined && input.capture !== undefined && input.diff !== undefined
    && input.restore !== undefined && input.remove !== undefined && input.setPinned !== undefined
  const load = (): void => {
    const isCurrent = beginRequest()
    const sessionId = input.currentSessionId()
    if (!input.enabled || !wired) { if (isCurrent()) { setCheckpoints([]); setSelected(undefined); setPreview(undefined); setWorkspaceUnavailable(false); setError(undefined) }; return }
    if (sessionId === undefined) { if (isCurrent()) { setCheckpoints([]); setSelected(undefined); setPreview(undefined); setError(undefined); setWorkspaceUnavailable(true); setBusy(false) }; return }
    setWorkspaceUnavailable(false)
    setBusy(true)
    setError(undefined)
    void input.list(sessionId).then((result) => {
      if (!isCurrent()) return
      if (!result.ok) { setError(result.error.message); return }
      setCheckpoints(result.value)
      // Drop a selection whose checkpoint no longer exists (retention eviction
      // runs on capture, so the list can shrink under a stale selection).
      if (selected !== undefined && !result.value.some(item => item.id === selected)) { setSelected(undefined); setPreview(undefined) }
    }, (reason: unknown) => { if (isCurrent()) setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { if (isCurrent()) setBusy(false) })
  }
  useEffect(() => { load() }, [input.enabled, input.list, input.currentSessionId])
  const inspect = (id: string): void => {
    const sessionId = input.currentSessionId()
    if (sessionId === undefined || busy || !wired) return
    const isCurrent = beginRequest()
    setSelected(id)
    setPreview(undefined)
    setNotice(undefined)
    setBusy(true)
    void input.diff(sessionId, { id }).then((result) => {
      if (!isCurrent()) return
      if (!result.ok) { setError(result.error.message); return }
      setPreview(result.value)
    }, (reason: unknown) => { if (isCurrent()) setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { if (isCurrent()) setBusy(false) })
  }
  const capture = (): void => {
    const sessionId = input.currentSessionId()
    if (sessionId === undefined || busy || !wired) return
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    void input.capture(sessionId, { label: label.trim() === '' ? 'manual checkpoint' : label.trim() }).then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      setLabel('')
      setNotice(`已创建检查点「${result.value.label}」，包含 ${result.value.entries.length} 个文件。`)
      load()
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const restore = (id: string): void => {
    const sessionId = input.currentSessionId()
    if (sessionId === undefined || busy || !wired) return
    if (typeof globalThis.confirm === 'function' && !globalThis.confirm('恢复此检查点会覆盖当前工作区文件，并删除该检查点之后新建的文件。此操作无法撤销，确定继续？')) return
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    void input.restore(sessionId, { id }).then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      setNotice(`已恢复 ${result.value.restoredFiles} 个文件，删除 ${result.value.deletedFiles} 个文件${result.value.missingBlobs > 0 ? `，${result.value.missingBlobs} 个对象缺失` : ''}。`)
      load()
      setPreview(undefined)
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const remove = (id: string): void => {
    const sessionId = input.currentSessionId()
    if (sessionId === undefined || busy || !wired) return
    setBusy(true)
    setError(undefined)
    void input.remove(sessionId, { id }).then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      if (selected === id) { setSelected(undefined); setPreview(undefined) }
      load()
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const togglePinned = (id: string, pinned: boolean): void => {
    const sessionId = input.currentSessionId()
    if (sessionId === undefined || busy || !wired) return
    setBusy(true)
    void input.setPinned(sessionId, { id, pinned }).then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      load()
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const current = checkpoints.find(item => item.id === selected)
  /**
   * The Host refuses a checkpoint call it cannot place in a workspace, and that
   * refusal is a precondition rather than a failure: `engineeringMemoryCwd`
   * needs a conversation whose header carries a `cwd`, so a panel opened with no
   * workspace-backed conversation gets the same sentence the memory, CodeGraph
   * and canvas panels already recognize through `isWorkspaceContextError`. Those
   * panels route it to their "open a workspace conversation" body; this one was
   * the only surface that printed it as a red alert, which read as a broken
   * feature instead of "nothing is open yet". Reopening or switching to a
   * workspace conversation clears the state through `load()`.
   */
  const workspaceRefusal = isWorkspaceContextError(error)
  /**
   * A diff can name thousands of files, so the chip list is capped — but the
   * summary line above it prints the full count, and a bare `slice` would make
   * the cap read as the whole list. Disclosing the cap keeps the two halves of
   * the panel telling the same story.
   */
  const DIFF_CHIP_LIMIT = 40
  const diffTags = (prefix: string, kind: string, files: readonly string[]): ReactNode => {
    if (files.length === 0) return null
    return <>
      <div className={css.memoryTags}>{files.slice(0, DIFF_CHIP_LIMIT).map(file => <span key={`${prefix}:${file}`}>{kind} {file}</span>)}</div>
      {files.length <= DIFF_CHIP_LIMIT ? null : <small className={css.sectionMeta}>仅显示前 {DIFF_CHIP_LIMIT} 个，共 {files.length} 个（另有 {files.length - DIFF_CHIP_LIMIT} 个未列出）。</small>}
    </>
  }
  return <section className={css.memoryPanel}>
    <header className={css.engineeringHeader}><div><div className={css.engineeringKicker}>WORKSPACE CHECKPOINTS</div><strong>工作区检查点</strong><small>文件修改前的安全快照；恢复前先预览差异。</small></div><div className={css.memoryActions}><button className={css.button} type="button" onClick={load} disabled={!input.enabled || busy}>刷新</button></div></header>
    {error === undefined || workspaceRefusal ? null : <div className={css.alert} role="alert">检查点操作失败：{error}</div>}
    {notice === undefined ? null : <small className={css.sectionMeta} role="status">{notice}</small>}
    {!wired ? <div className={css.emptyCapability}><strong>当前 Host 不支持工作区检查点</strong><small>该功能需要更新版本的 FreeCodeGo 插件；更新后重启 Harness 即可使用。</small></div>
      : !input.enabled ? <div className={css.emptyCapability}><strong>工作区检查点未启用</strong><small>{input.detail ?? '开启工程增强后，文件修改前的快照会自动保存。'}</small></div>
        : workspaceUnavailable || workspaceRefusal || input.currentSessionId() === undefined ? <div className={css.emptyCapability}><strong>打开工作区对话后查看检查点</strong><small>检查点按项目隔离；打开一个绑定工作区的对话后才能创建和恢复。</small></div>
          : <>
            <div className={css.engineeringComposer}><input className={css.input} value={label} placeholder="检查点名称（可选）" onChange={(event) => { setLabel(event.target.value) }} disabled={busy} aria-label="检查点名称" /><button className={`${css.button} ${css.buttonPrimary}`} type="button" onClick={capture} disabled={busy}>创建检查点</button></div>
            {checkpoints.length === 0 ? <div className={css.emptyCapability}><strong>还没有检查点</strong><small>修改任意文件后会自动生成，也可以上方手动创建。</small></div>
              : <div className={css.memoryList}>{checkpoints.map(checkpoint => <article key={checkpoint.id} className={`${css.memoryRecord} ${selected === checkpoint.id ? css.memoryRecordSelected : ''}`}>
                <button className={css.memoryRecordSelect} type="button" onClick={() => { inspect(checkpoint.id) }} disabled={busy}>
                  <span><strong>{checkpoint.pinned === true ? '📌 ' : ''}{checkpoint.label}</strong><small>{engineeringMemoryDate(checkpoint.createdAt)} · {checkpoint.entries.length} 个文件</small></span>
                </button>
                <div className={css.memoryRecordActions}>
                  <button className={css.button} type="button" onClick={() => { togglePinned(checkpoint.id, checkpoint.pinned !== true) }} disabled={busy}>{checkpoint.pinned === true ? '取消置顶' : '置顶'}</button>
                  <button className={css.button} type="button" onClick={() => { remove(checkpoint.id) }} disabled={busy}>删除</button>
                </div>
              </article>)}</div>}
            {selected === undefined || current === undefined ? null : <article className={css.memoryDetail}>
              <div className={css.memoryDetailHeader}><div><strong>{current.label}</strong><small>{engineeringMemoryDate(current.createdAt)} · {current.entries.length} 个文件</small></div>
                <div><button className={css.button} type="button" onClick={() => { restore(current.id) }} disabled={busy}>恢复到此检查点</button></div></div>
              {preview === undefined ? <small className={css.sectionMeta}>{busy ? '正在计算差异…' : '选择后将显示与当前工作区的差异。'}</small>
                : <div className={css.memoryTimeline}>
                  <strong>与当前工作区的差异</strong>
                  <small>修改：{preview.modified.length} 个 · 之后新增：{preview.addedSince.length} 个 · 之后删除：{preview.deletedSince.length} 个{preview.missingBlobs > 0 ? ` · 对象缺失：${preview.missingBlobs}` : ''}</small>
                  {preview.modified.length === 0 && preview.addedSince.length === 0 && preview.deletedSince.length === 0
                    ? <small>工作区与该检查点一致，无需恢复。</small>
                    : <>
                      {diffTags('m', '改', preview.modified)}
                      {diffTags('a', '增', preview.addedSince)}
                      {diffTags('d', '删', preview.deletedSince)}
                    </>}
                </div>}
            </article>}
          </>}
  </section>
}

/** One line describing an inspect section's payload, the way the Host's own renderer does. */
function inspectSectionSummary(data: FreeCodeGoInspectReport['sections'][number]['data']): string {
  if (Array.isArray(data)) return `${data.length} 项`
  if (typeof data === 'object' && data !== null) {
    const record = data as Readonly<Record<string, FreeCodeGoInspectReport['sections'][number]['data']>>
    const keys = Object.keys(record)
    const counts = keys.filter(key => typeof record[key] === 'number').map(key => `${key}=${String(record[key])}`)
    return counts.length > 0 ? counts.join(' ') : `${keys.length} 个字段`
  }
  return String(data)
}

/**
 * The unified loaded-surface report.
 *
 * The Host has answered "what is actually loaded?" from one collection pass
 * through three doors for a while — the `engineering_inspect` tool, the
 * `/inspect` command, and the `inspectReport` Remote — and only the Remote had
 * no surface, so a client that can call neither of the other two had no way to
 * ask. This panel is that door, and it is read-only because the report is a
 * statement of what the Host found: nothing here should be able to change it.
 *
 * A section that could not be collected renders as its reason rather than as an
 * empty row. "No MCP servers configured" and "the MCP config was unreadable"
 * look identical when only the payload is shown, which is the difference this
 * panel exists to make visible.
 */
export function InspectPanel(input: {
  readonly report?: (() => Promise<RemoteResult<FreeCodeGoInspectReport>>) | undefined
}): ReactNode {
  const [snapshot, setSnapshot] = useState<FreeCodeGoInspectReport | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const load = (): void => {
    if (input.report === undefined || busy) return
    setBusy(true)
    setError(undefined)
    void input.report().then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      setSnapshot(result.value)
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  useEffect(() => { load() }, [input.report])
  // A Host that predates this Remote renders nothing rather than throwing
  // during the mount effect, which would abort every later effect in the tab.
  if (input.report === undefined) return null
  const unavailable = snapshot?.unavailable ?? []
  return <section className={css.graphPanel}>
    <div className={css.memoryHeader}><div><strong>加载面检查</strong><small>一次收集十个面：文件夹授信、生效策略、沙箱、Skill、Hooks、规则与项目指令、Agents 与 personas、MCP 服务、引擎、扫描选择。它和 `engineering_inspect` 工具、`/inspect` 命令读的是同一次收集，三者不会互相矛盾。只读，不会改动任何设置或文件。</small></div><div className={css.accountActions}>{snapshot === undefined ? null : <span className={`${css.badge} ${unavailable.length === 0 ? css.badgeLive : css.badgeDanger}`}>{unavailable.length === 0 ? '全部可读' : `${unavailable.length} 个面不可读`}</span>}<button className={css.button} type="button" onClick={load} disabled={busy}>{busy ? '读取中…' : snapshot === undefined ? '读取报告' : '重新读取'}</button></div></div>
    {error === undefined ? null : <div className={css.alert} role="alert">加载面报告读取失败：{error}</div>}
    {snapshot === undefined ? null : <>
      <small className={css.sectionMeta} role="status">收集时间 {new Date(snapshot.generatedAt).toLocaleString()} · {snapshot.sections.length} 个面{unavailable.length === 0 ? '，没有面失败。' : `，其中 ${unavailable.join('、')} 收集失败，下面各自写明原因。`}</small>
      <div className={css.memoryList}>{snapshot.sections.map(section => <article className={css.memoryRecord} key={section.id}>
        <div className={css.accountIdentity}>
          <strong className={css.accountName}>{section.title}</strong>
          <small>{section.status === 'ok' ? inspectSectionSummary(section.data) : `不可读：${section.reason ?? '未给出原因'}`}</small>
          {section.status === 'ok' ? <details className={css.details}><summary className={css.detailsSummary}>原始数据</summary><pre className={css.diagnosticsDump}>{JSON.stringify(section.data, null, 2)}</pre></details> : null}
        </div>
        <span className={`${css.badge} ${css.inspectStatus} ${section.status === 'ok' ? '' : css.badgeDanger}`}>{section.status === 'ok' ? '已读取' : '不可读'}</span>
      </article>)}</div>
    </>}
  </section>
}

/**
 * The plan-review overlay: the read half and the write half of one surface.
 *
 * `planReviewOpen` prints the plan with line numbers and its section warnings,
 * and `planReviewCompose` turns line-level remarks into the rework message.
 * Neither had a caller in the UI, so review existed only for the plugin-side
 * path (the plan file plus `engineering_plan_mode`) and a user could not attach
 * a remark to the line it was about.
 *
 * The composed message is shown for the user to send rather than sent from
 * here: no Remote in this plugin writes a message into the conversation, and
 * inventing a delivery path would produce the one outcome a review step must
 * not — a rework request the user believes was sent.
 */
export function PlanReviewOverlay(input: {
  readonly open?: ((sessionId: string) => Promise<RemoteResult<FreeCodeGoPlanReviewSurface>>) | undefined
  readonly compose?: ((request: FreeCodeGoPlanReviewRequest) => Promise<RemoteResult<{ readonly message?: string; readonly rejected?: string }>>) | undefined
  readonly currentSessionId: () => string | undefined
}): ReactNode {
  const [showing, setShowing] = useState(false)
  const [surface, setSurface] = useState<FreeCodeGoPlanReviewSurface | undefined>(undefined)
  const [selection, setSelection] = useState<{ readonly start: number; readonly end: number } | undefined>(undefined)
  const [remarks, setRemarks] = useState<readonly { readonly startLine: number; readonly endLine: number; readonly text: string }[]>([])
  const [draft, setDraft] = useState('')
  const [notes, setNotes] = useState('')
  const [composed, setComposed] = useState<string | undefined>(undefined)
  const [refusal, setRefusal] = useState<string | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const load = (): void => {
    if (input.open === undefined || busy) return
    const sessionId = input.currentSessionId()
    if (sessionId === undefined) { setError('打开一个绑定工作区的会话后才能复核方案。'); return }
    setBusy(true)
    setError(undefined)
    setRefusal(undefined)
    void input.open(sessionId).then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      setSurface(result.value)
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  // The plan is edited by the plugin's own tool, so the surface is re-read on
  // open rather than kept from a previous review of a document that has moved.
  const openReview = (): void => {
    setShowing(true)
    setSelection(undefined)
    setRemarks([])
    setDraft('')
    setNotes('')
    setComposed(undefined)
    setRefusal(undefined)
    setCopied(false)
    load()
  }
  const selectLine = (line: number): void => {
    setSelection(current => current === undefined || line < current.start ? { start: line, end: line } : { start: current.start, end: line })
  }
  const addRemark = (): void => {
    if (selection === undefined || draft.trim() === '') return
    setRemarks(current => [...current, { startLine: selection.start, endLine: selection.end, text: draft.trim() }])
    setDraft('')
    setSelection(undefined)
  }
  const submit = (): void => {
    if (input.compose === undefined || busy) return
    const sessionId = input.currentSessionId()
    if (sessionId === undefined) { setError('打开一个绑定工作区的会话后才能提交返工请求。'); return }
    setBusy(true)
    setError(undefined)
    setRefusal(undefined)
    setComposed(undefined)
    setCopied(false)
    const trimmed = notes.trim()
    void input.compose({ sessionId, comments: remarks, ...(trimmed === '' ? {} : { notes: trimmed }) }).then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      // A refusal is a successful call carrying `rejected`, not a RemoteError.
      if (result.value.rejected !== undefined) { setRefusal(result.value.rejected); return }
      setComposed(result.value.message)
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const copy = (): void => {
    if (composed === undefined) return
    const clipboard = globalThis.navigator?.clipboard
    if (clipboard === undefined) { setCopied(false); return }
    void clipboard.writeText(composed).then(() => { setCopied(true) }, () => { setCopied(false) })
  }
  if (input.open === undefined) return null
  const rawLines = surface === undefined ? [] : surface.body.split('\n')
  const lines = rawLines.length > 0 && rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines
  const warnings = surface === undefined ? [] : [...surface.missingSections.map(section => `缺少小节：${section}`), ...surface.emptySections.map(section => `小节为空：${section}`), ...surface.warnings]
  return <section className={css.graphPanel}>
    <div className={css.memoryHeader}><div><strong>方案复核</strong><small>读取当前会话的方案文档，按行选段后写下意见，再生成一条返工消息发给 Agent。行号与 Host 打印的一致，所以意见不会落到另一行上。</small></div><div className={css.accountActions}><button className={css.button} type="button" aria-label="open-plan-review" onClick={openReview} disabled={busy}>{busy ? '读取中…' : '打开方案复核'}</button></div></div>
    {error === undefined || showing ? null : <div className={css.alert} role="alert">方案复核不可用：{error}</div>}
    <Modal open={showing} onClose={() => { setShowing(false) }} title="方案复核" closeLabel="关闭方案复核">
      {error === undefined ? null : <div className={css.alert} role="alert">方案复核失败：{error}</div>}
      {surface === undefined ? null : <>
        <small className={css.sectionMeta} role="status">{surface.empty ? '还没有方案：批准它会结束 Plan Mode 并让 Agent 直接开始；要求修改则会先让它写出一份方案。' : `${surface.lineCount} 行 · ${surface.path}`}</small>
        {warnings.length === 0 ? null : <div className={css.memoryTags}>{warnings.map(warning => <span key={warning}>{warning}</span>)}</div>}
        <div className={css.planReviewBody}>{lines.map((line, index) => {
          const number = index + 1
          const selected = selection !== undefined && number >= selection.start && number <= selection.end
          return <button className={`${css.planReviewLine} ${selected ? css.planReviewLineSelected : ''}`} type="button" key={number} aria-label={`plan-line-${number}`} aria-pressed={selected} onClick={() => { selectLine(number) }}>
            <span className={css.planReviewLineNumber}>{number}</span>
            <span className={css.planReviewLineText}>{line === '' ? ' ' : line}</span>
          </button>
        })}</div>
        <div className={css.planReviewRemark}>
          <small className={css.statLabel}>{selection === undefined ? '点一行选中它，再点另一行选出一段范围。' : selection.start === selection.end ? `已选第 ${selection.start} 行` : `已选第 ${selection.start}–${selection.end} 行`}</small>
          <textarea className={css.textarea} aria-label="remark-text" value={draft} placeholder="这一行要怎么改" onChange={(event) => { setDraft(event.target.value) }} disabled={busy} />
          <div className={css.accountActions}><button className={css.button} type="button" aria-label="add-remark" onClick={addRemark} disabled={busy || selection === undefined || draft.trim() === ''}>添加意见</button></div>
        </div>
        {remarks.length === 0 ? null : <div className={css.memoryList}>{remarks.map((remark, index) => <div className={css.memoryRecord} key={`${remark.startLine}-${remark.endLine}-${index}`}>
          <div className={css.accountIdentity}><strong className={css.accountName}>{remark.startLine === remark.endLine ? `第 ${remark.startLine} 行` : `第 ${remark.startLine}–${remark.endLine} 行`}</strong><small>{remark.text}</small></div>
          <button className={css.button} type="button" aria-label={`remove-remark-${index}`} onClick={() => { setRemarks(current => current.filter((_item, position) => position !== index)) }} disabled={busy}>移除</button>
        </div>)}</div>}
        <textarea className={css.textarea} aria-label="review-notes" value={notes} placeholder="整体意见（可选）" onChange={(event) => { setNotes(event.target.value) }} disabled={busy} />
        {refusal === undefined ? null : <div className={css.alert} role="alert">返工请求未被接受：{refusal}</div>}
        <div className={css.accountActions}><button className={`${css.button} ${css.buttonPrimary}`} type="button" aria-label="compose-rework" onClick={submit} disabled={busy || input.compose === undefined || (remarks.length === 0 && notes.trim() === '')}>{busy ? '生成中…' : '生成返工消息'}</button></div>
        {composed === undefined ? null : <div className={css.memoryDetail}>
          <div className={css.memoryDetailHeader}><div><strong>返工消息</strong><small>复制后粘贴给 Agent。这里不代你发送：插件里没有能把消息写进对话的 Remote。</small></div><div><button className={css.button} type="button" aria-label="copy-rework" onClick={copy}>复制</button></div></div>
          <pre className={css.diagnosticsDump}>{composed}</pre>
          {copied ? <small className={css.sectionMeta} role="status">已复制。</small> : null}
        </div>}
      </>}
    </Modal>
  </section>
}

function EngineeringGraphPanel(input: {
  readonly enabled: boolean
  readonly currentSessionId: () => string | undefined
  readonly runtimeStatus: EngineeringSectionInjected['engineeringGraphRuntimeStatus']
  readonly runtimePackages: EngineeringSectionInjected['engineeringGraphRuntimePackages']
  readonly install: EngineeringSectionInjected['engineeringGraphRuntimeInstall']
  readonly remove: EngineeringSectionInjected['engineeringGraphRuntimeRemove']
  readonly projectStatus: EngineeringSectionInjected['engineeringGraphProjectStatus']
  readonly build: EngineeringSectionInjected['engineeringGraphBuild']
  readonly update: EngineeringSectionInjected['engineeringGraphUpdate']
  readonly cancel: EngineeringSectionInjected['engineeringGraphCancel']
  readonly canvas: EngineeringSectionInjected['engineeringGraphCanvas']
  readonly clear: EngineeringSectionInjected['engineeringGraphClearProject']
}): ReactNode {
  const [runtime, setRuntime] = useState<EngineeringGraphRuntimeStatus | undefined>(undefined)
  const [packages, setPackages] = useState<readonly EngineeringGraphRuntimePackage[]>([])
  const [project, setProject] = useState<EngineeringGraphProjectStatus | undefined>(undefined)
  const [canvas, setCanvas] = useState<EngineeringCanvasGraph | undefined>(undefined)
  const [pythonPath, setPythonPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [workspaceUnavailable, setWorkspaceUnavailable] = useState(false)
  const beginRequest = useLatestRequestGuard()
  const applyRuntimePackages = (value: readonly EngineeringGraphRuntimePackage[]): void => {
    setPackages(value)
    if (pythonPath.trim() === '') {
      const detected = value.find(entry => entry.id === 'existing-python')?.detectedPath
      if (detected !== undefined) setPythonPath(detected)
    }
  }
  const refresh = (): void => {
    const isCurrent = beginRequest()
    if (!input.enabled) { if (isCurrent()) { setRuntime(undefined); setProject(undefined); setCanvas(undefined); setWorkspaceUnavailable(false); setError(undefined); setBusy(false) }; return }
    const sessionId = input.currentSessionId()
    if (sessionId === undefined) {
      setBusy(true)
      setError(undefined)
      void Promise.all([input.runtimeStatus(), input.runtimePackages()]).then(([runtimeResult, packageResult]) => {
        if (!isCurrent()) return
        if (runtimeResult.ok) setRuntime(runtimeResult.value)
        else setError(runtimeResult.error.message)
        if (packageResult.ok) applyRuntimePackages(packageResult.value)
        setProject(undefined)
        setCanvas(undefined)
        setWorkspaceUnavailable(true)
      }, (reason: unknown) => { if (isCurrent()) setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { if (isCurrent()) setBusy(false) })
      return
    }
    setWorkspaceUnavailable(false)
    setBusy(true)
    setError(undefined)
    const projectState = sessionId === undefined
      ? Promise.resolve<RemoteResult<EngineeringGraphProjectStatus> | undefined>(undefined)
      : input.projectStatus(sessionId).catch((reason: unknown) => ({ ok: false as const, error: { message: reason instanceof Error ? reason.message : String(reason) } }))
    void Promise.all([input.runtimeStatus(), input.runtimePackages(), projectState]).then(([runtimeResult, packageResult, projectResult]) => {
      if (!isCurrent()) return
      if (!runtimeResult.ok) { setError(runtimeResult.error.message); return }
      setRuntime(runtimeResult.value)
      if (packageResult.ok) applyRuntimePackages(packageResult.value)
      if (projectResult !== undefined && projectResult.ok) setProject(projectResult.value)
      else if (projectResult !== undefined && !projectResult.ok) {
        if (isWorkspaceContextError(projectResult.error.message)) { setProject(undefined); setCanvas(undefined); setWorkspaceUnavailable(true); setError(undefined) }
        else setError(projectResult.error.message)
      }
    }, (reason: unknown) => { if (isCurrent()) setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { if (isCurrent()) setBusy(false) })
  }
  useEffect(() => { refresh() }, [input.enabled, input.runtimeStatus, input.runtimePackages, input.projectStatus, input.currentSessionId])
  const install = (entry: EngineeringGraphRuntimePackage): void => {
    if (busy || !entry.compatible) return
    if (entry.requiresPath && pythonPath.trim() === '') { setError('请填写已有 Python 可执行文件的完整路径。'); return }
    setBusy(true)
    setError(undefined)
    void input.install({ packageId: entry.id, ...(entry.requiresPath ? { pythonPath: pythonPath.trim() } : {}) }).then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      setRuntime(result.value)
      refresh()
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const remove = (): void => {
    if (busy || runtime?.installed !== true) return
    if (typeof globalThis.confirm === 'function' && !globalThis.confirm('移除插件私有的 Graphify Runtime？已经构建的项目图谱会保留。')) return
    setBusy(true)
    void input.remove().then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      setRuntime(result.value)
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const build = (force: boolean): void => {
    const sessionId = input.currentSessionId()
    if (sessionId === undefined || busy || runtime?.installed !== true) return
    setBusy(true)
    setError(undefined)
    void input.build(sessionId, { force }).then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      setProject(result.value)
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const update = (): void => {
    const sessionId = input.currentSessionId()
    if (sessionId === undefined || busy) return
    setBusy(true); setError(undefined)
    void input.update(sessionId).then((result) => { if (result.ok) setProject(result.value); else setError(result.error.message) }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const clear = (): void => {
    const sessionId = input.currentSessionId()
    if (sessionId === undefined || busy) return
    if (typeof globalThis.confirm === 'function' && !globalThis.confirm('清空当前工作区的插件私有代码图谱和缓存？')) return
    setBusy(true); setError(undefined)
    void input.clear(sessionId).then((result) => { if (result.ok) setProject(result.value); else setError(result.error.message) }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const cancel = (): void => {
    const sessionId = input.currentSessionId()
    if (sessionId === undefined || busy) return
    setBusy(true)
    void input.cancel(sessionId).then((result) => { if (!result.ok) setError(result.error.message); else refresh() }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const loadCanvas = (): void => {
    const sessionId = input.currentSessionId()
    if (sessionId === undefined || busy || project?.state !== 'ready') return
    setBusy(true); setError(undefined)
    void input.canvas(sessionId, { maxNodes: 120 }).then((result) => { if (result.ok) setCanvas(result.value); else setError(result.error.message) }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const projectLabel = project?.state === 'ready' ? `已构建 · ${project.graphBytes === undefined ? '图谱就绪' : `${Math.ceil(project.graphBytes / 1024)} KiB`}`
    : project?.state === 'building' ? '正在构建'
      : project?.state === 'missing' ? '当前工作区尚未构建'
        : project?.reason ?? '打开工作区对话后可查看图谱状态'
  const hasSession = input.currentSessionId() !== undefined
  return <section className={css.graphPanel}>
    <header className={css.engineeringHeader}><div><div className={css.engineeringKicker}>CODE ATLAS</div><strong>代码结构图</strong><small>文件、模块、函数与调用关系，保存在 FreeCodeGo 数据目录。</small></div><div className={css.memoryActions}><button className={css.button} type="button" onClick={refresh} disabled={!input.enabled || busy}>刷新</button>{runtime?.installed ? <button className={`${css.button} ${css.buttonDanger}`} type="button" onClick={remove} disabled={busy}>移除环境</button> : null}</div></header>
    {error === undefined ? null : <div className={css.alert} role="alert">代码结构图操作失败：{error}</div>}
    {!input.enabled ? <div className={css.emptyCapability}><strong>代码结构图未启用</strong><small>启用后 AI 可以查询项目结构和影响范围。</small></div> : workspaceUnavailable || !hasSession ? <div className={css.emptyCapability}><strong>打开工作区对话后查看图谱状态</strong><small>代码图按项目工作区隔离；Runtime 可以在此管理，构建和查询需要一个绑定工作区的对话。</small></div> : runtime?.installed ? <><div className={css.graphState}><strong>{runtime.state === 'ready' ? '代码图 Runtime 已就绪' : '代码图 Runtime 需要修复'}</strong><small>{projectLabel}</small></div>{canvas === undefined ? null : <div className={css.engineeringSummary}><span><b>{canvas.nodes.length}</b> 个节点</span><span><b>{canvas.edges.length}</b> 条边</span>{canvas.truncated ? <span>已按安全上限截断</span> : null}</div>}<div className={css.memoryActions}><button className={`${css.button} ${css.buttonPrimary}`} type="button" onClick={() => { build(false) }} disabled={busy || !hasSession}>构建当前工作区</button><button className={css.button} type="button" onClick={update} disabled={busy || project?.state !== 'ready'}>增量更新</button><button className={css.button} type="button" onClick={() => { build(true) }} disabled={busy || !hasSession}>重新构建</button>{project?.state === 'building' ? <button className={css.button} type="button" onClick={cancel} disabled={busy}>取消构建</button> : null}<button className={css.button} type="button" onClick={loadCanvas} disabled={busy || project?.state !== 'ready'}>预览 Canvas</button><button className={css.button} type="button" onClick={clear} disabled={busy || project?.state !== 'ready'}>清空图谱</button></div>{canvas === undefined ? null : <div className={css.graphState}><strong>Canvas 适配数据</strong><small>{canvas.nodes.length} 个节点 · {canvas.edges.length} 条边{canvas.truncated ? ' · 已按安全上限截断' : ''}</small></div>}</> : <div className={css.graphInstallList}>{packages.map(entry => <div key={entry.id} className={css.graphInstallRow}><div><strong>{entry.label}</strong><small>{entry.detail}</small>{entry.requiresPath ? <input className={css.input} value={pythonPath} onChange={(event) => { setPythonPath(event.target.value) }} placeholder="Python 可执行文件路径，例如 C:\\Python312\\python.exe" /> : null}</div><button className={`${css.button} ${css.buttonPrimary}`} type="button" onClick={() => { install(entry) }} disabled={busy || !entry.compatible}>{entry.compatible ? entry.id === 'managed-uv-python' ? '自动安装' : '使用此 Python 安装' : '当前不可用'}</button></div>)}</div>}
  </section>
}

/**
 * The Python-free code-graph engine. It sits next to the Graphify panel so a
 * user can run either, both, or neither; unlike Graphify its runtime is one
 * verified self-contained download, and its index lives in the workspace.
 */
function EngineeringCodeGraphPanel(input: {
  readonly enabled: boolean
  readonly currentSessionId: () => string | undefined
  readonly runtimeStatus: EngineeringSectionInjected['engineeringCodeGraphRuntimeStatus']
  readonly runtimePackages: EngineeringSectionInjected['engineeringCodeGraphRuntimePackages']
  readonly install: EngineeringSectionInjected['engineeringCodeGraphRuntimeInstall']
  readonly remove: EngineeringSectionInjected['engineeringCodeGraphRuntimeRemove']
  readonly projectStatus: EngineeringSectionInjected['engineeringCodeGraphProjectStatus']
  readonly build: EngineeringSectionInjected['engineeringCodeGraphBuild']
  readonly sync: EngineeringSectionInjected['engineeringCodeGraphSync']
  readonly cancel: EngineeringSectionInjected['engineeringCodeGraphCancel']
  readonly clear: EngineeringSectionInjected['engineeringCodeGraphClearProject']
}): ReactNode {
  const [runtime, setRuntime] = useState<EngineeringCodeGraphRuntimeStatus | undefined>(undefined)
  const [packages, setPackages] = useState<readonly EngineeringCodeGraphRuntimePackage[]>([])
  const [project, setProject] = useState<EngineeringCodeGraphProjectStatus | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [workspaceUnavailable, setWorkspaceUnavailable] = useState(false)
  const beginRequest = useLatestRequestGuard()
  const refresh = (): void => {
    const isCurrent = beginRequest()
    if (!input.enabled) { if (isCurrent()) { setRuntime(undefined); setProject(undefined); setWorkspaceUnavailable(false); setError(undefined); setBusy(false) }; return }
    const sessionId = input.currentSessionId()
    setBusy(true)
    setError(undefined)
    const projectState = sessionId === undefined
      ? Promise.resolve<RemoteResult<EngineeringCodeGraphProjectStatus> | undefined>(undefined)
      : input.projectStatus(sessionId).catch((reason: unknown) => ({ ok: false as const, error: { message: reason instanceof Error ? reason.message : String(reason) } }))
    void Promise.all([input.runtimeStatus(), input.runtimePackages(), projectState]).then(([runtimeResult, packageResult, projectResult]) => {
      if (!isCurrent()) return
      if (!runtimeResult.ok) { setError(runtimeResult.error.message); return }
      setRuntime(runtimeResult.value)
      if (packageResult.ok) setPackages(packageResult.value)
      if (projectResult !== undefined && projectResult.ok) { setProject(projectResult.value); setWorkspaceUnavailable(false) }
      else if (projectResult !== undefined) {
        if (isWorkspaceContextError(projectResult.error.message)) { setProject(undefined); setWorkspaceUnavailable(true); setError(undefined) }
        else setError(projectResult.error.message)
      }
    }, (reason: unknown) => { if (isCurrent()) setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { if (isCurrent()) setBusy(false) })
  }
  useEffect(() => { refresh() }, [input.enabled, input.runtimeStatus, input.runtimePackages, input.projectStatus, input.currentSessionId])
  const install = (): void => {
    if (busy || runtime?.installed === true) return
    setBusy(true)
    setError(undefined)
    void input.install().then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      setRuntime(result.value)
      refresh()
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const remove = (): void => {
    if (busy || runtime?.installed !== true) return
    if (typeof globalThis.confirm === 'function' && !globalThis.confirm('移除插件私有的 CodeGraph Runtime？已经构建的工作区索引会保留。')) return
    setBusy(true)
    void input.remove().then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      setRuntime(result.value)
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const build = (force: boolean): void => {
    const sessionId = input.currentSessionId()
    if (sessionId === undefined || busy || runtime?.installed !== true) return
    setBusy(true)
    setError(undefined)
    void input.build(sessionId, { force }).then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      setProject(result.value)
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const sync = (): void => {
    const sessionId = input.currentSessionId()
    if (sessionId === undefined || busy) return
    setBusy(true); setError(undefined)
    void input.sync(sessionId).then((result) => { if (result.ok) setProject(result.value); else setError(result.error.message) }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const clear = (): void => {
    const sessionId = input.currentSessionId()
    if (sessionId === undefined || busy) return
    if (typeof globalThis.confirm === 'function' && !globalThis.confirm('删除当前工作区的 CodeGraph 索引目录？')) return
    setBusy(true); setError(undefined)
    void input.clear(sessionId).then((result) => { if (result.ok) setProject(result.value); else setError(result.error.message) }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const cancel = (): void => {
    const sessionId = input.currentSessionId()
    if (sessionId === undefined || busy) return
    setBusy(true)
    void input.cancel(sessionId).then((result) => { if (!result.ok) setError(result.error.message); else refresh() }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const projectLabel = project?.state === 'ready' ? `已构建 · ${project.builtAt === undefined ? '索引就绪' : new Date(project.builtAt).toLocaleString()}`
    : project?.state === 'building' ? '正在构建'
      : project?.state === 'missing' ? '当前工作区尚未构建索引'
        : project?.reason ?? '打开工作区对话后可查看索引状态'
  const hasSession = input.currentSessionId() !== undefined
  return <section className={css.graphPanel}>
    <header className={css.engineeringHeader}><div><div className={css.engineeringKicker}>CODE INDEX</div><strong>CodeGraph 索引（免 Python）</strong><small>自包含运行环境，无需 Python 与 uv；索引保存在当前工作区的 .codegraph-freecodego 目录。</small></div><div className={css.memoryActions}><button className={css.button} type="button" onClick={refresh} disabled={!input.enabled || busy}>刷新</button>{runtime?.installed ? <button className={`${css.button} ${css.buttonDanger}`} type="button" onClick={remove} disabled={busy}>移除环境</button> : null}</div></header>
    {error === undefined ? null : <div className={css.alert} role="alert">CodeGraph 操作失败：{error}</div>}
    {!input.enabled ? <div className={css.emptyCapability}><strong>代码结构图未启用</strong><small>启用后 AI 可以通过 CodeGraph 索引查询项目结构与影响范围。</small></div> : workspaceUnavailable || !hasSession ? <div className={css.emptyCapability}><strong>打开工作区对话后查看 CodeGraph 状态</strong><small>运行环境可以在此管理；构建与查询需要一个绑定工作区的对话。</small></div> : runtime?.installed ? <><div className={css.graphState}><strong>{runtime.state === 'ready' ? `CodeGraph ${runtime.version} 已就绪` : 'CodeGraph Runtime 需要修复'}</strong><small>{projectLabel}</small></div><div className={css.memoryActions}><button className={`${css.button} ${css.buttonPrimary}`} type="button" onClick={() => { build(false) }} disabled={busy || !hasSession}>构建或增量更新</button><button className={css.button} type="button" onClick={() => { build(true) }} disabled={busy || !hasSession}>完整重建索引</button><button className={css.button} type="button" onClick={sync} disabled={busy || project?.state !== 'ready'}>仅同步变更</button>{project?.state === 'building' ? <button className={css.button} type="button" onClick={cancel} disabled={busy}>取消构建</button> : null}<button className={css.button} type="button" onClick={clear} disabled={busy || project?.state !== 'ready'}>删除索引</button></div><div className={css.graphState}><strong>索引位置</strong><small>{project?.indexPath ?? '当前工作区 .codegraph-freecodego/codegraph.db'}{project?.indexBytes === undefined ? '' : ` · ${Math.ceil(project.indexBytes / 1024)} KiB`}</small></div></> : <div className={css.graphInstallList}>{packages.map(entry => <div key={entry.id} className={css.graphInstallRow}><div><strong>{entry.label}</strong><small>{entry.detail}</small></div><button className={`${css.button} ${css.buttonPrimary}`} type="button" onClick={install} disabled={busy || !entry.compatible}>{entry.compatible ? '下载并安装' : '当前不可用'}</button></div>)}</div>}
  </section>
}

/** Dedicated sidebar surface for the plugin-owned engineering enhancement pack. */
/** Phase wording shared by the loop panel's status line and its badge. */
const ENGINEERING_LOOP_PHASE_LABELS: Record<EngineeringLoopPhase, string> = {
  active: '进行中',
  paused: '已暂停',
  blocked: '被阻塞',
  complete: '已完成',
}

export function EngineeringSettingsSection({ engineeringStatus, engineeringSetEnabled, engineeringSettingsUpdate, engineeringLoopStatus, engineeringLoopArm, engineeringLoopStop, engineeringCouncilReports, engineeringTeamJob, engineeringTeamCancel, engineeringTeamReports, engineeringTeamDecision, engineeringTeamVerify, engineeringTeamImplementation, engineeringMemoryList, engineeringMemorySearch, engineeringMemoryRecall, engineeringMemoryTimeline, engineeringMemoryGet, engineeringMemoryReview, engineeringMemoryDelete, engineeringMemoryPurgeProject, engineeringMemoryExport, engineeringMemoryBackup, engineeringMemoryRetentionSweep, engineeringMemoryConsolidate, engineeringMemoryManifest, engineeringSpecExport, engineeringEval, engineeringGraphRuntimeStatus, engineeringGraphRuntimePackages, engineeringGraphRuntimeInstall, engineeringGraphRuntimeRemove, engineeringGraphProjectStatus, engineeringGraphBuild, engineeringGraphUpdate, engineeringGraphCancel, engineeringGraphCanvas, engineeringGraphClearProject, engineeringCodeGraphRuntimeStatus, engineeringCodeGraphRuntimePackages, engineeringCodeGraphRuntimeInstall, engineeringCodeGraphRuntimeRemove, engineeringCodeGraphProjectStatus, engineeringCodeGraphBuild, engineeringCodeGraphSync, engineeringCodeGraphCancel, engineeringCodeGraphClearProject, engineeringCheckpointList, engineeringCheckpointCapture, engineeringCheckpointDiff, engineeringCheckpointRestore, engineeringCheckpointRemove, engineeringCheckpointSetPinned, inspectReport, planReviewOpen, planReviewCompose, currentSessionId }: EngineeringSectionProps): ReactNode {
  const [status, setStatus] = useState<EngineeringStatus | undefined>(undefined)
  const [loop, setLoop] = useState<EngineeringLoopStatus | undefined>(undefined)
  const [loopError, setLoopError] = useState<string | undefined>(undefined)
  const [councilReports, setCouncilReports] = useState<readonly EngineeringCouncilReport[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [specResult, setSpecResult] = useState<FreeCodeGoEngineeringSpecBundle | undefined>(undefined)
  const [teamJob, setTeamJob] = useState<EngineeringTeamJob | undefined>(undefined)
  const pollTeam = (): void => {
    if (teamJob?.id === undefined || engineeringTeamJob === undefined || busy) return
    setBusy(true)
    void engineeringTeamJob(teamJob.id).then((result) => { if (result.ok) setTeamJob(result.value); else setError(result.error.message) }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const cancelTeam = (): void => {
    if (teamJob?.id === undefined || engineeringTeamCancel === undefined || busy) return
    setBusy(true)
    void engineeringTeamCancel(teamJob.id).then((result) => { if (result.ok) setTeamJob(result.value); else setError(result.error.message) }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const decideTeam = (decision: 'approved' | 'rejected'): void => {
    const sessionId = currentSessionId()
    if (sessionId === undefined || teamJob?.id === undefined || engineeringTeamDecision === undefined || busy) return
    setBusy(true)
    void engineeringTeamDecision(sessionId, { id: teamJob.id, decision }).then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      setTeamJob(current => current === undefined ? current : { ...current, decision: result.value, report: current.report === undefined ? undefined : { ...current.report, decision: result.value } } as EngineeringTeamJob)
      // The Host moved the job to `implementing`, but the local snapshot still
      // says `completed` — the polling effect ignores that state, so the
      // follow-up buttons never appeared until the user clicked "刷新状态".
      // Re-fetch the authoritative job state immediately.
      if (engineeringTeamJob !== undefined) {
        void engineeringTeamJob(teamJob.id).then((reloaded) => { if (reloaded.ok) setTeamJob(reloaded.value) }, () => undefined)
      }
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const verifyTeam = (): void => {
    const sessionId = currentSessionId()
    if (sessionId === undefined || teamJob?.id === undefined || engineeringTeamVerify === undefined || busy) return
    setBusy(true)
    void engineeringTeamVerify(sessionId, { id: teamJob.id }).then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      setTeamJob(current => current === undefined ? current : { ...current, verification: result.value, report: current.report === undefined ? undefined : { ...current.report, verification: result.value } } as EngineeringTeamJob)
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const markTeamImplemented = (): void => {
    const sessionId = currentSessionId()
    if (sessionId === undefined || teamJob?.id === undefined || engineeringTeamImplementation === undefined || busy) return
    const summary = typeof window.prompt === 'function' ? window.prompt('请输入实施摘要（已修改哪些内容、使用了哪些验证）：', teamJob.report?.plan ?? '') : null
    if (summary === null || summary.trim() === '') return
    setBusy(true)
    void engineeringTeamImplementation(sessionId, { id: teamJob.id, summary: summary.trim() }).then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      setTeamJob(current => current === undefined ? current : { ...current, state: 'awaiting_verification', implementation: result.value, report: current.report === undefined ? undefined : { ...current.report, implementation: result.value } } as EngineeringTeamJob)
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const hasSession = currentSessionId() !== undefined
  // The loop belongs to a session, not to the settings document.
  const loopSessionId = currentSessionId()
  const teamDecision = teamJob?.decision ?? teamJob?.report?.decision
  const teamVerification = teamJob?.verification ?? teamJob?.report?.verification
  useEffect(() => {
    let active = true
    void engineeringStatus().then((result) => {
      if (!active) return
      if (result.ok) setStatus(result.value)
      else setError(result.error.message)
    }, (reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { active = false }
  }, [engineeringStatus])
  useEffect(() => {
    const sessionId = currentSessionId()
    if (sessionId === undefined || engineeringTeamReports === undefined) return
    void engineeringTeamReports(sessionId).then((result) => {
      if (!result.ok || result.value.length === 0) return
      const latest = result.value.at(-1)
      if (latest === undefined) return
      const report = latest
      setTeamJob({ id: report.id, state: engineeringTeamState(report), sessionId, report })
    }).catch(() => undefined)
  }, [currentSessionId, engineeringTeamReports])
  useEffect(() => {
    if (teamJob?.id === undefined || engineeringTeamJob === undefined) return
    if (teamJob.state !== 'queued' && teamJob.state !== 'running' && teamJob.state !== 'implementing' && teamJob.state !== 'verifying') return
    let active = true
    const timer = window.setInterval(() => {
      if (!active || busy) return
      void engineeringTeamJob(teamJob.id).then((result) => {
        if (active && result.ok) setTeamJob(result.value)
      }).catch(() => undefined)
    }, 2_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [teamJob?.id, teamJob?.state, engineeringTeamJob, busy])
  const exportTeamReport = (): void => {
    const report = teamJob?.report
    if (report === undefined || typeof document === 'undefined') return
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `freecodego-council-${report.id}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }
  const update = (patch: Partial<EngineeringSettings>): void => {
    if (busy) return
    setBusy(true)
    void engineeringSettingsUpdate(patch).then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      setStatus(result.value)
      publishEngineeringSnapshot(result.value)
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  // The loop's goal is not a setting: the round driver creates, blocks and
  // completes it while the panel is open, so the panel polls instead of
  // showing whatever was true when it mounted.
  useEffect(() => {
    if (loopSessionId === undefined || engineeringLoopStatus === undefined || status?.engineeringEnabled !== true) {
      setLoop(undefined)
      return
    }
    let active = true
    const read = (): void => {
      void engineeringLoopStatus(loopSessionId).then((result) => {
        if (!active) return
        if (result.ok) { setLoop(result.value); setLoopError(undefined); return }
        setLoopError(result.error.message)
      }, (reason: unknown) => { if (active) setLoopError(reason instanceof Error ? reason.message : String(reason)) })
    }
    read()
    const timer = window.setInterval(read, 5_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [loopSessionId, engineeringLoopStatus, status?.engineeringEnabled])
  const controlLoop = (action: 'arm' | 'stop'): void => {
    const call = action === 'arm' ? engineeringLoopArm : engineeringLoopStop
    if (loopSessionId === undefined || call === undefined || busy) return
    setBusy(true)
    setLoopError(undefined)
    void call(loopSessionId).then((result) => {
      if (!result.ok) { setLoopError(result.error.message); return }
      setLoop(result.value)
    }, (reason: unknown) => { setLoopError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  useEffect(() => {
    const sessionId = currentSessionId()
    if (sessionId === undefined) { setCouncilReports([]); return }
    void engineeringCouncilReports(sessionId).then((result) => { if (result.ok) setCouncilReports(result.value) }).catch(() => undefined)
  }, [currentSessionId, engineeringCouncilReports])
  /**
   * Render the approved council plan into `<workspace>/specs/<id>`.
   *
   * Deliberately offered only for an approved report: the Host refuses an export
   * whose report has no approval, and it says so as an error. Hiding the action
   * until approval exists is what keeps a refusal from looking like a bug.
   */
  const exportSpecPlan = (): void => {
    const sessionId = currentSessionId()
    const id = teamJob?.report?.id
    if (sessionId === undefined || id === undefined || busy) return
    setBusy(true)
    setSpecResult(undefined)
    setError(undefined)
    void engineeringSpecExport(sessionId, { id }).then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      setSpecResult(result.value)
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  const loopSummary = loopSessionId === undefined
    ? '当前没有打开的会话。目标属于会话，打开一个会话后这里会显示它的目标、阶段和回合用量。'
    : loop === undefined
      ? '正在读取当前会话的目标…'
      : ! loop.available
        ? '当前组合没有挂载 Harness 目标服务，这个回路无法创建或继续目标。'
        : loop.goalId === undefined
          ? '当前会话还没有目标：批准一份工程议会方案后会自动创建。'
          : [
            loop.objectiveExcerpt ?? '（目标没有可读的描述）',
            loop.phase === undefined ? undefined : ENGINEERING_LOOP_PHASE_LABELS[loop.phase],
            loop.roundsStarted === undefined || loop.maxGoalRounds === undefined ? undefined : `已用 ${loop.roundsStarted}/${loop.maxGoalRounds} 回合`,
            loop.activation === 'armed' ? '可无人继续' : '不会自行继续',
          ].filter(part => part !== undefined).join(' · ')
  return <section className={`${css.section} ${css.engineeringSection}`}>
    <div className={css.sectionHeader}><div><div className={css.kicker}>ENGINEERING</div><strong className={css.sectionName}>工程增强包</strong></div><span className={`${css.badge} ${status?.engineeringEnabled ? css.badgeLive : ''}`}>{status?.engineeringEnabled ? '已启用' : '未启用'}</span></div>
    <small className={css.sectionMeta}>让 AI 在本地持续理解你的项目：使用工程 Skill、共享长期记忆和代码结构图，帮助不同 Agent 延续上下文并减少重复分析。</small>
    {error === undefined ? null : <div className={css.alert} role="alert">工程增强状态读取失败：{error}</div>}
    <div className={css.extensionList}>
      <label className={css.extensionRow}><span><strong>启用工程增强包</strong><small>启用后注册内置工程 Skill 与受审计的 Host 工具。</small></span><input className={css.switch} aria-label="启用工程增强包" type="checkbox" checked={status?.engineeringEnabled === true} onChange={(event) => { if (busy) return; setBusy(true); void engineeringSetEnabled(event.target.checked).then((result) => { if (!result.ok) { setError(result.error.message); return }; setStatus(result.value); publishEngineeringSnapshot(result.value) }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) }) }} disabled={busy} /></label>
      <label className={css.extensionRow}><span><strong>常用技能（默认开启）</strong><small>精选十个：四个只在对应任务出现时参与的工作纪律（完成前先拿证据、先选最小检索手段、多文件改动先出方案、从最小复现定位根因）；六个需要时手打即用的技能——`/grill-me` 追问打磨方案、`/handoff` 压缩成交接文档、`/wait-what` 没讲明白时重讲一遍、`/to-questionnaire` 把只有你能定的决策变成问卷、`/prompt-techniques` 中文提示词速查，以及被 `/grill-me` 调用的追问原语。手打类的技能不进模型目录、不会自动触发。</small></span><input className={css.switch} aria-label="启用常用技能" type="checkbox" checked={status?.engineeringStarterSkillsEnabled === true} onChange={(event) => { update({ engineeringStarterSkillsEnabled: event.target.checked }) }} disabled={busy || status?.engineeringEnabled !== true} /></label>
      <label className={css.extensionRow}><span><strong>全部工程 Skills</strong><small>在常用技能之外再挂载其余 {Math.max(0, (status?.builtinSkillCount ?? 0) - 10 - 8)} 个规划、检索、调试与安全工作流（发布/安全评审、规格挖掘、上下文控制、深度模块设计与原型等，含多个第三方 MIT 技能）。默认关闭，因为一次挂载三十多个技能会让模型更容易选错流程；这套里那几个会往仓里写文档或需要先配 issue tracker 的（如 `/grill-with-docs`、`/to-spec`、`/triage`），也不适合默认替你做决定。</small></span><input className={css.switch} aria-label="启用全部工程 Skills" type="checkbox" checked={status?.engineeringSkillsEnabled === true} onChange={(event) => { update({ engineeringSkillsEnabled: event.target.checked }) }} disabled={busy || status?.engineeringEnabled !== true} /></label>
      <label className={css.extensionRow}><span><strong>Superpowers 工作流包</strong><small>第三方（MIT）交付流水线：需求追问并定稿方案、写实施计划、按任务派发子 Agent 并逐项复核、收尾决定合并方式。它是模型自动触发的，与上面的工程 Skills 相互独立，因此单独一个开关且默认关闭。启用前请确认你接受「先出方案、经你批准再动手」的节奏。</small></span><input className={css.switch} aria-label="启用 Superpowers 工作流包" type="checkbox" checked={status?.engineeringSuperpowersSkillsEnabled === true} onChange={(event) => { update({ engineeringSuperpowersSkillsEnabled: event.target.checked }) }} disabled={busy || status?.engineeringEnabled !== true} /></label>
      <label className={css.extensionRow}><span><strong>Skill 能力地图</strong><small>会话开始时向 AI 注入一份已挂载 Skill 的清单（按「用户可调用 / 模型可调用」分组），让默认关闭的技能库仍然可被发现。只列名称与一行简介，不加载技能正文。</small></span><input className={css.switch} aria-label="启用 Skill 能力地图" type="checkbox" checked={status?.engineeringSkillMapEnabled === true} onChange={(event) => { update({ engineeringSkillMapEnabled: event.target.checked }) }} disabled={busy || status?.engineeringEnabled !== true} /></label>
      <label className={css.extensionRow}><span><strong>项目长期记忆</strong><small>自动保存项目决策、修复经验和跨 Agent 交接，后续对话会继续使用这些信息。</small></span><input className={css.switch} aria-label="启用项目长期记忆" type="checkbox" checked={status?.engineeringMemoryEnabled === true} onChange={(event) => { update({ engineeringMemoryEnabled: event.target.checked }) }} disabled={busy || status?.engineeringEnabled !== true} /></label>
      <label className={css.extensionRow}><span><strong>代码结构图</strong><small>把文件、模块、函数和调用关系整理成可查询图谱，帮助 AI 定位影响范围。</small></span><input className={css.switch} aria-label="启用代码结构图" type="checkbox" checked={status?.engineeringCodeGraphEnabled === true} onChange={(event) => { update({ engineeringCodeGraphEnabled: event.target.checked }) }} disabled={busy || status?.engineeringEnabled !== true} /></label>
      {status?.engineeringCodeGraphEnabled !== true ? null : <label className={css.extensionRow}><span><strong>代码图引擎</strong><small>决定由哪个引擎提供 AI 的代码图工具：自动优先使用自包含的 CodeGraph（无需 Python），装不到时回退 Graphify。只有被选中的引擎会注册工具，因此不会重复占用上下文。</small></span><select className={`${css.select} ${css.engineSelect}`} aria-label="选择代码图引擎" value={status?.engineeringGraphEngine ?? 'auto'} onChange={(event) => { update({ engineeringGraphEngine: event.target.value as 'auto' | 'graphify' | 'codegraph' }) }} disabled={busy || ! status?.engineeringEnabled}><option value="auto">自动（优先 CodeGraph）</option><option value="graphify">Graphify（私有 Python）</option><option value="codegraph">CodeGraph（免 Python）</option></select></label>}
      <label className={css.extensionRow}><span><strong>实施后验证</strong><small>批准方案并完成实施后，允许主 Agent 运行项目声明的构建、类型、Lint 和测试脚本。通过项目声明的脚本不算验证完成：每个阶段都要带上真正执行的命令和退出码，且至少一条对抗性探针成立，才会被记为“已验证”。</small></span><input className={css.switch} aria-label="启用实施后验证" type="checkbox" checked={status?.engineeringQualityEnabled === true} onChange={(event) => { update({ engineeringQualityEnabled: event.target.checked }) }} disabled={busy || status?.engineeringEnabled !== true} /></label>
    </div>
    {status?.engineeringEnabled !== true ? null : <section className={css.graphPanel}>
      <header className={css.engineeringHeader}><div><div className={css.engineeringKicker}>自动化回路</div><strong>无人值守工程回路</strong><small>把「批准实施」之后的事情拆成三个独立开关，因为它们的风险不同：记录目标只是承诺把事做完，自动继续则让工作在没有你说话的情况下往下走。</small></div><span className={`${css.councilState} ${css.councilStateNowrap}`}>{status.engineeringLoopAutoContinue ? '自动继续已开' : '自动继续已关'}</span></header>
      <div className={css.councilCallout}><small className={css.statLabel}>必须知道的一点</small><p>{status.engineeringLoopAutoContinue ? '开启后，完成一轮的 Agent 可以在没有你回复的情况下开始下一轮，直到达到回合上限或完成目标。随时关掉这个开关即可停下。' : '除了「自动继续」，其余两项都不会让工作在无人应答时自行推进；默认状态下每一轮都由你触发。'}</p></div>
      <label className={css.extensionRow}><span><strong>批准后记录为长期目标</strong><small>你批准方案副本时，把方案落成一个持久目标，之后的会话仍能看到它没做完。</small></span><input className={css.switch} aria-label="批准后记录为长期目标" type="checkbox" checked={status.engineeringLoopCapturePlan} onChange={(event) => { update({ engineeringLoopCapturePlan: event.target.checked }) }} disabled={busy} /></label>
      <label className={css.extensionRow}><span><strong>目标完成时运行验证</strong><small>目标驱动报告完成时，自动跑一次项目声明的验证脚本并记录结果，而不是只听它说完成了。</small></span><input className={css.switch} aria-label="目标完成时运行验证" type="checkbox" checked={status.engineeringLoopVerifyOnComplete} onChange={(event) => { update({ engineeringLoopVerifyOnComplete: event.target.checked }) }} disabled={busy} /></label>
      <label className={css.toggleCard}><span className={css.toggleCardText}><strong>允许无人值守自动继续</strong><small>默认关闭，因为它会在没有你回复的情况下继续执行。开启前请确认目标与回合上限都对。</small></span><input className={css.switch} aria-label="允许无人值守自动继续" type="checkbox" checked={status.engineeringLoopAutoContinue} onChange={(event) => { update({ engineeringLoopAutoContinue: event.target.checked }) }} disabled={busy} /></label>
      <label className={css.extensionRow}><span><strong>目标最大回合数</strong><small>范围 1–256，默认 24。达到上限后驱动停止，不会无限跑下去。</small></span><input className={css.input} aria-label="目标最大回合数" type="number" min={1} max={256} step={1} value={status.engineeringLoopMaxGoalRounds ?? 24} onChange={(event) => { const parsed = Number(event.target.value); if (!Number.isFinite(parsed)) return; update({ engineeringLoopMaxGoalRounds: Math.max(1, Math.min(256, Math.round(parsed))) }) }} disabled={busy} style={{ maxWidth: '120px' }} /></label>
      <div className={css.councilCallout}>
        <small className={css.statLabel}>当前目标</small>
        <p>{loopSummary}</p>
        {loopError === undefined && loop?.blockedMessage === undefined ? null : <p role="alert">{loopError ?? `停止原因：${loop?.blockedMessage ?? ''}`}</p>}
        <div className={css.accountActions}>
          <button className={css.button} type="button" onClick={() => { controlLoop('arm') }} disabled={busy || loop?.goalId === undefined || loop?.phase === 'complete' || ! status.engineeringLoopAutoContinue}>继续无人值守</button>
          <button className={css.button} type="button" onClick={() => { controlLoop('stop') }} disabled={busy || loop?.phase !== 'active'}>停止</button>
        </div>
        {status.engineeringLoopAutoContinue ? null : <p>「继续无人值守」需要先打开上面的「允许无人值守自动继续」——那个开关是授权无人推进的唯一地方，关掉它也会立刻停止正在进行的无人值守。</p>}
      </div>
    </section>}
    {status?.engineeringEnabled === true ? <section className={css.graphPanel}>
      <header className={css.engineeringHeader}><div><div className={css.engineeringKicker}>方案复核</div><strong>智能方案复核</strong><small>方案获批后，系统会自动请其他引擎检查风险和实施步骤，再由当前 Agent 继续执行。</small></div><span className={`${css.councilState} ${css.councilStateNowrap}`}>{status.engineeringCouncilAutoRun ? '自动复核已开' : '自动复核已关'}</span></header>
      <div className={css.councilCallout}><small className={css.statLabel}>工作方式</small><p>{status.engineeringCouncilAutoRun ? '其他引擎只阅读项目并提出建议，不会修改文件；当前 Agent 汇总意见后继续执行。' : '开启后，方案获批时会自动启动复核，不需要再次填写目标或手动启动。'}</p></div>
      <label className={css.toggleCard}><span className={css.toggleCardText}><strong>自动复核已批准方案</strong><small>默认关闭；开启后每份方案只复核一次，避免重复打扰。</small></span><input className={css.switch} aria-label="允许主 Agent 自动调度三引擎协作" type="checkbox" checked={status.engineeringCouncilAutoRun} onChange={(event) => { update({ engineeringCouncilAutoRun: event.target.checked }) }} disabled={busy} /></label>
      {teamJob === undefined ? <small className={css.sectionMeta}>当前没有进行中的复核。批准方案后会自动开始。</small> : <div className={css.councilJob}><div className={css.councilJobHead}><span className={css.councilState}>{teamJob.state}</span><small className={css.councilJobId}>{teamJob.id}</small></div><div className={css.accountActions}><button className={css.button} type="button" onClick={pollTeam} disabled={busy}>刷新状态</button>{teamJob.state === 'queued' || teamJob.state === 'running' ? <button className={css.button} type="button" onClick={cancelTeam} disabled={busy}>取消协作</button> : null}</div></div>}
    </section> : null}
    {teamJob?.report === undefined ? null : <section className={css.graphPanel}><div className={css.memoryHeader}><div><strong>协作决策与验证</strong><small>协作报告只提供证据。必须由用户明确批准后，主 Agent 才能实施；实施完成后运行项目声明的验证脚本。</small></div></div><div className={css.accountActions}>{teamDecision === undefined && (teamJob.state === 'completed' || teamJob.state === 'partial' || teamJob.state === 'awaiting_approval') ? <><button className={css.button} type="button" onClick={() => { decideTeam('approved') }} disabled={busy || engineeringTeamDecision === undefined}>批准实施</button><button className={css.button} type="button" onClick={() => { decideTeam('rejected') }} disabled={busy || engineeringTeamDecision === undefined}>拒绝方案</button></> : teamDecision?.state === 'approved' && teamVerification === undefined && teamJob.state === 'implementing' && teamJob.report.implementation === undefined ? <button className={css.button} type="button" onClick={markTeamImplemented} disabled={busy || engineeringTeamImplementation === undefined}>标记已实施</button> : teamDecision?.state === 'approved' && teamVerification === undefined && (teamJob.state === 'awaiting_verification' || teamJob.report.implementation !== undefined) ? <button className={css.button} type="button" onClick={verifyTeam} disabled={busy || engineeringTeamVerify === undefined}>运行实施后验证</button> : null}<button className={css.button} type="button" onClick={exportTeamReport} disabled={busy}>导出报告</button>{teamDecision?.state === 'approved' ? <button className={css.button} type="button" onClick={exportSpecPlan} disabled={busy}>{busy ? '导出中…' : '写出规格包'}</button> : null}</div>{specResult === undefined ? null : <small className={css.sectionMeta} role="status">{specResult.written ? `已写出 ${specResult.files.length} 个文件（${specResult.files.map(file => file.file).join(' · ')}）· ${specResult.tasks} 项任务 · ${specResult.directory}` : `未写出规格包：${specResult.reason}`}</small>}{teamDecision === undefined ? <small className={css.sectionMeta}>{teamJob.state === 'stale' ? '该方案或批准已过期，请重新运行协作审查。' : '尚未确认，主 Agent 不得实施。'}</small> : <div className={css.graphState}><strong>{teamDecision.state === 'approved' ? teamJob.state === 'stale' ? '批准已过期' : '用户已批准实施' : '用户已拒绝方案'}</strong>{teamJob.report.implementation === undefined ? null : <small>实施摘要：{teamJob.report.implementation.summary}</small>}{teamVerification === undefined ? null : <small>{engineeringVerificationLine(teamVerification, true)}</small>}</div>}</section>}
    {status?.engineeringCouncilEnabled && !hasSession ? <small className={css.sectionMeta}>打开一个绑定工作区的会话后，AI 才能读取项目并运行方案审查。</small> : null}
    {councilReports.length === 0 ? null : <section className={css.graphPanel}><div className={css.memoryHeader}><div><strong>Advisor Council 历史</strong><small>报告在会话事件中持久化保存，角色结论不会自动改变 Agent 行为。</small></div></div><div className={css.memoryList}>{councilReports.map(report => <article className={css.memoryRecord} key={report.id}><div className={css.councilReport}>
      <div className={css.councilJobHead}>
        <strong className={css.councilReportTurn}>回合 {report.turn}</strong>
        <small className={css.councilJobId}>{report.provider}/{report.model} · {engineeringMemoryDate(report.createdAt)}</small>
      </div>
      {report.findings.length === 0
        ? <small className={css.sectionMeta}>本次没有可报告的具体风险。</small>
        : <ul className={css.findingList}>{report.findings.map((finding, findingIndex) => <CouncilFindingRow engine={finding.role} severity={finding.severity} title={finding.role} evidence={finding.note} key={`${report.id}-${finding.role}-${findingIndex}`} />)}</ul>}
    </div></article>)}</div></section>}
    <EngineeringMemoryPanel enabled={status?.engineeringEnabled === true && status.engineeringMemoryEnabled && status.modules.some(module => module.id === 'memory' && module.state === 'available')} currentSessionId={currentSessionId} list={engineeringMemoryList} timeline={engineeringMemoryTimeline} get={engineeringMemoryGet} review={engineeringMemoryReview} remove={engineeringMemoryDelete} purge={engineeringMemoryPurgeProject} exportReviewed={engineeringMemoryExport} backup={engineeringMemoryBackup} retentionSweep={engineeringMemoryRetentionSweep} search={engineeringMemorySearch} recall={engineeringMemoryRecall} consolidate={engineeringMemoryConsolidate} manifest={engineeringMemoryManifest} />
    <EngineeringCheckpointPanel enabled={status?.engineeringEnabled === true && status.modules.some(module => module.id === 'checkpoints' && module.state === 'available')} detail={status?.modules.find(module => module.id === 'checkpoints')?.detail} currentSessionId={currentSessionId} list={engineeringCheckpointList} capture={engineeringCheckpointCapture} diff={engineeringCheckpointDiff} restore={engineeringCheckpointRestore} remove={engineeringCheckpointRemove} setPinned={engineeringCheckpointSetPinned} />

    <EngineeringGraphPanel enabled={status?.engineeringEnabled === true && status.engineeringCodeGraphEnabled} currentSessionId={currentSessionId} runtimeStatus={engineeringGraphRuntimeStatus} runtimePackages={engineeringGraphRuntimePackages} install={engineeringGraphRuntimeInstall} remove={engineeringGraphRuntimeRemove} projectStatus={engineeringGraphProjectStatus} build={engineeringGraphBuild} update={engineeringGraphUpdate} cancel={engineeringGraphCancel} canvas={engineeringGraphCanvas} clear={engineeringGraphClearProject} />
    <EngineeringCodeGraphPanel enabled={status?.engineeringEnabled === true && status.engineeringCodeGraphEnabled} currentSessionId={currentSessionId} runtimeStatus={engineeringCodeGraphRuntimeStatus} runtimePackages={engineeringCodeGraphRuntimePackages} install={engineeringCodeGraphRuntimeInstall} remove={engineeringCodeGraphRuntimeRemove} projectStatus={engineeringCodeGraphProjectStatus} build={engineeringCodeGraphBuild} sync={engineeringCodeGraphSync} cancel={engineeringCodeGraphCancel} clear={engineeringCodeGraphClearProject} />
    <EngineeringEvalPanel run={engineeringEval} />
    {/* Both new surfaces sit behind the engineering master switch: the report's
        sections and the plan under review are the engineering surfaces, and the
        `engineering_inspect` tool is not registered when the switch is off. */}
    {status?.engineeringEnabled === true ? <InspectPanel report={inspectReport} /> : null}
    {status?.engineeringEnabled === true ? <PlanReviewOverlay open={planReviewOpen} compose={planReviewCompose} currentSessionId={currentSessionId} /> : null}
  </section>
}

type ReadyState = { status: 'ready'; catalog: Catalog; managedCatalog: ManagedCatalog; account: AccountState; paymentConfig?: PaymentConfigSnapshot; vyce?: FreeCodeGoVyceStatus; logfare?: FreeCodeGoLogfareStatus; logfareSupported?: boolean; sensenova?: FreeCodeGoSenseNovaStatus; nvidia?: FreeCodeGoNvidiaStatus; plans: readonly PaymentPlan[]; channels: readonly PaymentChannel[]; gatewayPrices: readonly GatewayModelPrice[]; gatewayPricingError?: string | undefined; order?: PaymentOrder; pendingOrders?: readonly PaymentOrder[]; agnes?: AgnesStatus; cline?: ClineStatus; workbuddy?: WorkBuddyInternationalStatus; qoder?: QoderStatus; trae?: TraeStatus; actionError?: string; syncStatus?: 'refreshing' | 'offline'; syncError?: string }
// One member, because one member is what every producer builds: the cache read and
// the fallback are both `ReadyState`. A `loading` / `error` variant used to sit here
// with two consumers in the render body and **no producer anywhere**, so the panel
// carried a loading paragraph and an error line that could not render while reading
// as if they could — the syncing notice driven by `syncStatus` is what the user sees.
type State = ReadyState

const SETTINGS_CACHE_TTL_MS = 30 * 60_000
const SETTINGS_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000
const SETTINGS_CACHE_STORAGE_PREFIX = 'freecodego:settings-cache:v1:'
// Failed automatic media-default persistence backs off per category instead of
// being re-attempted on every rerender caused by the error state itself. The
// backoff is scoped to one mounted settings session and is dropped on unmount.
const MEDIA_DEFAULT_RETRY_AFTER_MS = 5 * 60_000
// The media defaults read is the only thing that can turn a cached value into
// the document's value, and everything automatic below hangs off it. One
// transient failure therefore must not be the answer for the whole panel.
const MEDIA_DEFAULTS_READ_RETRIES = 2
const MEDIA_DEFAULTS_READ_RETRY_MS = 1_500
/**
 * What the panel knows about the media defaults the settings document holds.
 *
 * `document` is a settled read; `pending` is a read in flight; `unavailable` is
 * a read that failed after its retries. The automatic adoption below runs only
 * on `document`: deciding from a cached or not-yet-read value is how a saved
 * image/video/audio selection got overwritten by an automatic pick.
 */
type MediaDefaultsSource = 'pending' | 'document' | 'unavailable'
const mediaDefaultRetryAfter = new Map<string, number>()
type SettingsCache = { readonly language: 'zh' | 'en'; readonly catalog: Injected['catalog']; readonly savedAt: number; readonly state: ReadyState }
let settingsCache: SettingsCache | undefined

function createLogfareCredentials(): { readonly username: string; readonly password: string } {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const passwordAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_'
  const random = (characters: string, length: number): string => {
    const values = new Uint32Array(length)
    if (globalThis.crypto?.getRandomValues !== undefined) globalThis.crypto.getRandomValues(values)
    else for (let index = 0; index < values.length; index += 1) values[index] = Math.floor(Math.random() * 0x1_0000_0000)
    return [...values].map(value => characters[value % characters.length]!).join('')
  }
  return { username: `fcg-${random(alphabet, 14)}`, password: random(passwordAlphabet, 22) }
}

function settingsStorage(): Storage | undefined {
  try { return globalThis.localStorage } catch { return undefined }
}

function settingsStorageKey(language: 'zh' | 'en'): string {
  return `${SETTINGS_CACHE_STORAGE_PREFIX}${language}`
}

function cachedSettings(language: 'zh' | 'en', catalog: Injected['catalog']): SettingsCache | undefined {
  if (settingsCache !== undefined && settingsCache.language === language && settingsCache.catalog === catalog) return settingsCache
  const storage = settingsStorage()
  if (storage === undefined) return undefined
  try {
    const payload = JSON.parse(storage.getItem(settingsStorageKey(language)) ?? '') as unknown
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
    const value = payload as { readonly savedAt?: unknown; readonly state?: unknown }
    if (typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt) || Date.now() - value.savedAt > SETTINGS_CACHE_MAX_AGE_MS) return undefined
    const state = value.state
    if (typeof state !== 'object' || state === null || Array.isArray(state) || (state as { readonly status?: unknown }).status !== 'ready') return undefined
    const candidate = state as ReadyState
    if (!Array.isArray(candidate.catalog.engines) || !Array.isArray(candidate.managedCatalog.models) || !Array.isArray(candidate.plans) || !Array.isArray(candidate.channels) || !Array.isArray(candidate.gatewayPrices)) return undefined
    // A failure written by an older build must not be replayed as a current
    // outage by a panel that has not re-read the tariff yet.
    settingsCache = { language, catalog, savedAt: value.savedAt, state: { ...candidate, gatewayPricingError: undefined } }
    return settingsCache
  } catch { return undefined }
}

function saveSettingsCache(language: 'zh' | 'en', catalog: Injected['catalog'], state: ReadyState): void {
  if (state.syncStatus !== undefined) return
  // Account details (email, balance) are user data and must not be cached in
  // browser storage; persist the view model with the account block stripped.
  // A gateway tariff read is a live probe rather than view state, so its failure
  // must not be persisted: a cached message re-rendered "pricing unavailable" on
  // the next visit long after the endpoint had recovered.
  const { account: _account, gatewayPricingError: _gatewayPricingError, ...rest } = state
  // The placeholder must not claim a sign-out either: the cached login form for
  // an account that is merely about to load is the flash this block kept causing.
  const cachedState: ReadyState = { ...rest, account: { status: 'loading' } }
  settingsCache = { language, catalog, savedAt: Date.now(), state: cachedState }
  const storage = settingsStorage()
  if (storage === undefined) return
  try {
    // This is a browser-safe view model only. Credentials remain Host-owned.
    storage.setItem(settingsStorageKey(language), JSON.stringify({ version: 1, savedAt: settingsCache.savedAt, state: cachedState }))
  } catch { /* Browser storage is optional and must not block the settings page. */ }
}

function fallbackSettings(): ReadyState {
  return {
    status: 'ready',
    catalog: { defaultEngine: 'deepseek', engines: [] },
    managedCatalog: withAgnesModels(emptyManagedCatalog),
    account: { status: 'loading' },
    plans: [],
    channels: [],
    gatewayPrices: [],
  }
}

/** Action errors patch the live view model instead of replacing it: a failed
 * login or request must never wipe already-loaded engines, models, and
 * provider accounts back to the bare fallback. */
function failed(detail: string): (previous: State) => State {
  return previous => previous.status === 'ready' ? { ...previous, actionError: detail } : previous
}

function unavailableRemoteMethod(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return /FreeCodeGo Remote method "[^"]+" did not become available/i.test(detail)
}

function expiredCredential(detail: string): boolean {
  return /\b(?:401|unauthori[sz]ed|token[\s_-]*expired|refresh[\s_-]*token|reauth(?:entication)?[\s_-]*required)\b|登录(?:状态|凭证)?.*(?:过期|失效)/i.test(detail)
}

function describeClineError(detail: string): string {
  if (/CLINE_NOT_CONFIGURED/i.test(detail)) return 'Cline 凭证服务尚未就绪，请稍后重试或重启 Harness。'
  if (/CLINE_LOGIN_REQUIRED/i.test(detail)) return '尚未添加 Cline 账号，请先添加账号。'
  if (/CLINE_REAUTH_REQUIRED/i.test(detail)) return '该 Cline 账号凭证已失效，请重新添加该账号。'
  if (/CLINE_LOGIN_FAILED/i.test(detail)) return `添加 Cline 账号失败：${detail.replace(/^CLINE_LOGIN_FAILED:\s*/i, '')}`
  return detail
}

/** Plain-language mapping for WorkBuddy International errors. */
function describeWorkbuddyError(detail: string): string {
  if (/WORKBUDDY_IMPORT_FAILED/i.test(detail)) return `WorkBuddy 授权导入失败：${detail.replace(/^WORKBUDDY_IMPORT_FAILED:\s*/i, '')}`
  if (/WORKBUDDY_NOT_CONFIGURED/i.test(detail)) return 'WorkBuddy 服务尚未就绪，请稍后重试或重启 Harness。'
  if (/WORKBUDDY_LOGIN_FAILED|invalid.*credential|unauthorized/i.test(detail)) return `WorkBuddy 登录失败：${detail.replace(/^WORKBUDDY_LOGIN_FAILED:\s*/i, '')}`
  if (/WORKBUDDY_LOGIN_REQUIRED/i.test(detail)) return '尚未登录 WorkBuddy，请先登录账号。'
  return detail
}

/** Plain-language mapping for Qoder errors. */
function describeQoderError(detail: string): string {
  if (/QODER_LOGIN_FAILED/i.test(detail)) return `Qoder 登录失败：${detail.replace(/^QODER_LOGIN_FAILED:\s*/i, '')}`
  if (/QODER_NOT_CONFIGURED/i.test(detail)) return 'Qoder 服务尚未就绪，请稍后重试或重启 Harness。'
  if (/QODER_LOGIN_REQUIRED/i.test(detail)) return '尚未登录 Qoder，请先登录账号。'
  return detail
}

/**
 * Plain-language mapping for Trae errors.
 *
 * Trae's sign-in ends at a loopback redirect the user may have to paste by hand,
 * so most of its failures are about the pasted link rather than the account; the
 * Host names each one, and a raw code is not something to show a user.
 */
function describeTraeError(detail: string): string {
  if (/TRAE_LOGIN_CALLBACK_EMPTY/i.test(detail)) return '回调链接为空，请粘贴浏览器地址栏中的完整链接。'
  if (/TRAE_LOGIN_CALLBACK_UNPARSEABLE/i.test(detail)) return '无法解析这个回调链接，请确认它包含 Trae 的授权参数（code 或 token）。'
  if (/TRAE_LOGIN_CALLBACK_WITHOUT_CREDENTIAL/i.test(detail)) return '这个回调链接里没有登录凭证，请完成登录后复制最终跳转的页面地址。'
  if (/TRAE_TOKEN_EXCHANGE_RETURNED_NO_TOKEN/i.test(detail)) return 'Trae 未返回访问令牌，请重新发起一次登录。'
  if (/TRAE_LOGIN_FAILED/i.test(detail)) return `Trae 登录失败：${detail.replace(/^TRAE_LOGIN_FAILED:\s*/i, '')}`
  if (/TRAE_LOGIN_REQUIRED/i.test(detail)) return '尚未登录 Trae，请先登录账号。'
  return detail
}

/**
 * The name the panel uses for one Trae deployment.
 *
 * The two are separate services with almost disjoint model catalogs, so "Trae"
 * alone stopped being a complete answer the moment the pool could hold both: a
 * user picking a model has to know which deployment offers it.
 * @param realm - the deployment from the Host's snapshot.
 * @param language - the UI language.
 * @returns the label to render.
 */
export function traeRealmName(realm: 'cn' | 'sg', language: 'zh' | 'en'): string {
  if (realm === 'cn') return language === 'zh' ? '国内版' : 'China'
  return language === 'zh' ? '国际版' : 'Global'
}

/**
 * One line describing what a daily check-in run collected.
 *
 * The run is the unit the user acted on, but the *account* is the unit they care
 * about: "+300 积分" on a two-account pool hides which account did not collect,
 * and a pool is exactly the case where one account's campaign can be closed
 * while another's is open. So the total leads and every account follows.
 * @param report - the run's report.
 * @param language - the UI language.
 * @returns the summary line.
 */
export function checkinSummary(report: FreeCodeGoCheckinReport, language: 'zh' | 'en'): string {
  const zh = language === 'zh'
  if (report.accounts.length === 0) return zh ? '没有已登录的账号，无法签到。' : 'No signed-in accounts to check in.'
  const lines = report.accounts.map((account) => {
    if (account.outcome === 'claimed') {
      // A claim and a refusal can happen in one run, and the collected amount is
      // all a summary would otherwise show — so a partial collection names what it
      // did not get.
      const refused = account.refused === undefined || account.refused === '' ? '' : zh ? `（${account.refused}）` : ` (${account.refused})`
      return zh ? `${account.label}：+${account.credits} 积分${refused}` : `${account.label}: +${account.credits} credits${refused}`
    }
    if (account.outcome === 'already') return zh ? `${account.label}：今日已签到` : `${account.label}: already checked in today`
    if (account.outcome === 'unavailable') return zh ? `${account.label}：签到活动未开启` : `${account.label}: campaign not running`
    const reason = account.message === undefined || account.message === '' ? '' : zh ? `（${account.message}）` : ` (${account.message})`
    return zh ? `${account.label}：签到失败${reason}` : `${account.label}: failed${reason}`
  })
  const total = report.credits <= 0 ? '' : zh ? `本次共 +${report.credits} 积分 · ` : `+${report.credits} credits this run · `
  return `${total}${lines.join(' · ')}`
}

/**
 * One account's live state, re-derived from its deadlines on every render.
 *
 * The Host snapshot lives in browser storage, so a stored `cooling` status can
 * outlive its own `cooldownUntil`; trusting the field made an elapsed park read
 * as “已限流，约 0 分钟后恢复”. The deadlines are the facts: an elapsed one is
 * simply not limited anymore, and only the routes still parked are listed.
 */
function clineAccountState(account: ClineAccountInfo): {
  readonly status: 'active' | 'cooling' | 'reauth-required'
  readonly coolingModels: readonly { readonly model: string; readonly until: number }[]
} {
  if (account.status === 'reauth-required') return { status: 'reauth-required', coolingModels: [] }
  const now = Date.now()
  return {
    status: (account.cooldownUntil ?? 0) > now ? 'cooling' : 'active',
    coolingModels: (account.coolingModels ?? []).filter(entry => entry.until > now),
  }
}

/** Minutes left on a deadline, for display. */
function clineRemainingMinutes(until: number): number {
  return Math.max(1, Math.ceil((until - Date.now()) / 60_000))
}

/** A wait as this card phrases it: minutes below an hour, hours and minutes above. */
function clineWaitText(minutes: number, language: 'zh' | 'en'): string {
  if (minutes < 60) return language === 'zh' ? `${minutes} 分钟` : `${minutes} min`
  return language === 'zh'
    ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** A credit amount as these cards read it: grouped, one decimal at most. */
function formatCredits(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)
}

/** Two-letter monogram for an account row. */
function poolMonogram(label: string): string {
  const name = (label.split('@')[0] ?? label).trim()
  const parts = name.split(/[._\-+\s]+/u).filter(part => part !== '')
  const letters = parts.length >= 2 ? `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}` : name.slice(0, 2)
  return letters.toUpperCase() === '' ? '··' : letters.toUpperCase()
}

/** How an expiry reads: a date, days left, or already gone. */
function creditExpiryLabel(at: number | undefined, language: 'zh' | 'en'): string | undefined {
  if (at === undefined) return undefined
  const zh = language === 'zh'
  const days = Math.ceil((at - Date.now()) / 86_400_000)
  if (days <= 0) return zh ? '已过期' : 'expired'
  if (days <= 30) return zh ? `${days} 天后到期` : `expires in ${days}d`
  return zh ? `${new Date(at).toLocaleDateString()} 到期` : `expires ${new Date(at).toLocaleDateString()}`
}

/** One account's credit line: what is left, or why that is unknown. */
function workbuddyCreditLine(credits: WorkBuddyInternationalAccountInfo['credits'], language: 'zh' | 'en'): string {
  const zh = language === 'zh'
  if (credits === undefined) return zh ? '积分额度尚未查询' : 'Credits not queried yet'
  if (credits.error !== undefined) return zh ? `额度查询失败：${credits.error}` : `Credit query failed: ${credits.error}`
  const amount = zh ? `积分 ${formatCredits(credits.remaining)} / ${formatCredits(credits.total)}` : `${formatCredits(credits.remaining)} / ${formatCredits(credits.total)} credits`
  const expiry = creditExpiryLabel(credits.soonestExpireAt, language)
  return expiry === undefined ? amount : `${amount} · ${expiry}`
}

/** Remaining share of an account's credits, 0–100. */
function workbuddyCreditPercent(credits: NonNullable<WorkBuddyInternationalAccountInfo['credits']>): number {
  if (!(credits.total > 0)) return 0
  return Math.min(100, Math.max(0, (credits.remaining / credits.total) * 100))
}

/** The states this card paints, in one vocabulary for both pools. */
type PoolChipTone = 'live' | 'warn' | 'danger' | 'idle'

/** One account's credit chips: credit position and credential pressure. */
function workbuddyAccountChips(
  account: WorkBuddyInternationalAccountInfo,
  language: 'zh' | 'en',
): readonly { readonly label: string; readonly tone: PoolChipTone; readonly title?: string }[] {
  const zh = language === 'zh'
  const chips: { label: string; tone: PoolChipTone; title?: string }[] = []
  if (account.credits?.error !== undefined) chips.push({ label: zh ? '额度读取失败' : 'credit read failed', tone: 'warn', title: account.credits.error })
  if (account.credits?.expired === true) chips.push({ label: zh ? '积分已过期' : 'credits expired', tone: 'danger' })
  else if (account.credits?.expiringSoon === true) chips.push({ label: zh ? '积分即将到期' : 'credits expiring', tone: 'warn' })
  if (!account.apiKeyConfigured) chips.push({ label: zh ? '缺少凭证' : 'no credential', tone: 'danger' })
  return chips
}

/** One Cline account's chips: pool state first, then per-model parks. */
function clineAccountChips(account: ClineAccountInfo, language: 'zh' | 'en'): readonly { readonly label: string; readonly tone: PoolChipTone }[] {
  const zh = language === 'zh'
  const accountState = clineAccountState(account)
  const chips: { label: string; tone: PoolChipTone }[] = []
  if (accountState.status === 'reauth-required') chips.push({ label: zh ? '需重新授权' : 're-auth required', tone: 'danger' })
  else if (accountState.status === 'cooling') chips.push({ label: zh ? '已限流' : 'rate limited', tone: 'warn' })
  else chips.push({ label: zh ? '参与轮询' : 'in rotation', tone: 'live' })
  // Free budgets are per model, so a partly parked account still serves: say
  // which part is out instead of painting the whole account as limited.
  if (accountState.coolingModels.length > 0) chips.push({ label: zh ? `${accountState.coolingModels.length} 个模型额度已用完` : `${accountState.coolingModels.length} models out`, tone: 'warn' })
  return chips
}

/**
 * One account in a provider pool: identity, state chips, actions, and an
 * optional meter.
 *
 * Both free-model providers render through this, which is what keeps them from
 * drifting into two different-looking lists — and the meter is optional so the
 * pool that has no per-account figure simply omits it instead of drawing a bar
 * with nothing behind it.
 */
function PoolAccountCard(input: {
  readonly monogram: string
  readonly name: string
  readonly note?: string | undefined
  readonly chips: readonly { readonly label: string; readonly tone: PoolChipTone; readonly title?: string | undefined }[]
  readonly meter?: { readonly percent: number; readonly label: string; readonly tone?: PoolChipTone } | undefined
  readonly children?: ReactNode
}): ReactNode {
  return <article className={css.poolAccount}>
    <div className={css.poolAccountHead}>
      <div className={css.poolIdentity}>
        <span className={css.poolMonogram} aria-hidden="true">{input.monogram}</span>
        <div className={css.poolIdentityText}>
          <strong className={css.poolName} title={input.name}>{input.name}</strong>
          {input.note === undefined ? null : <small className={css.poolSub}>{input.note}</small>}
        </div>
      </div>
      <div className={css.poolChips}>{input.chips.map(chip => <span
        className={`${css.poolChip} ${chip.tone === 'live' ? css.poolChipLive : chip.tone === 'warn' ? css.poolChipWarn : chip.tone === 'danger' ? css.poolChipDanger : ''}`}
        key={chip.label}
        title={chip.title}
      >{chip.label}</span>)}</div>
      <div className={css.poolActions}>{input.children}</div>
    </div>
    {input.meter === undefined ? null : <div className={css.poolMeterRow}>
      <span className={css.poolMeterTrack} role="img" aria-label={input.meter.label}>
        <span
          className={`${css.poolMeterFill} ${input.meter.tone === 'warn' ? css.poolMeterFillWarn : input.meter.tone === 'danger' ? css.poolMeterFillDanger : ''}`}
          style={{ width: `${input.meter.percent}%` }}
        />
      </span>
      <span className={css.poolMetric}>{input.meter.label}</span>
    </div>}
  </article>
}

/** One plain-language line per Cline account so a stalled pool is explainable. */
function clineAccountStatusLabel(account: ClineAccountInfo, language: 'zh' | 'en'): string {
  const state = clineAccountState(account)
  const zh = language === 'zh'
  if (state.status === 'reauth-required') return zh ? '凭证失效，请重新添加该账号' : 'Credential expired, re-add this account'
  if (state.status === 'cooling') {
    const wait = clineWaitText(clineRemainingMinutes(account.cooldownUntil ?? 0), language)
    return zh ? `已限流，约 ${wait}后恢复` : `Rate limited, about ${wait} left`
  }
  if (state.coolingModels.length === 0) return zh ? '可用，参与轮询' : 'Active, in the rotation'
  // Free budgets are per model, so a route park leaves the account usable: name
  // the models that are out and say so, instead of painting the whole account as
  // limited and hiding the models that still work.
  const routes = state.coolingModels
    .map(entry => zh
      ? `${entry.model}（约 ${clineWaitText(clineRemainingMinutes(entry.until), language)}后恢复）`
      : `${entry.model} (${clineWaitText(clineRemainingMinutes(entry.until), language)} left)`)
    .join('、')
  return zh
    ? `可用，参与轮询 · ${state.coolingModels.length} 个模型免费额度已用完：${routes}`
    : `Active · ${state.coolingModels.length} model${state.coolingModels.length === 1 ? '' : 's'} out of free budget: ${routes}`
}

/** Percent label for a usage window; a window without numbers renders nothing. */
function clineUsagePercent(window: { readonly usedPercent?: number; readonly used?: number; readonly limit?: number }): string | undefined {
  if (window.usedPercent !== undefined && Number.isFinite(window.usedPercent)) return `${Math.round(window.usedPercent)}%`
  if (window.used !== undefined && window.limit !== undefined && window.limit > 0) return `${Math.round(Math.min(100, Math.max(0, window.used / window.limit * 100)))}%`
  return undefined
}

/** Human label for a stable usage-window key. */
function clineUsageWindowLabel(id: string, language: 'zh' | 'en'): string {
  const zh = language === 'zh'
  switch (id) {
    case 'five-hour': return zh ? '5 小时窗口' : '5-hour window'
    case 'weekly': return zh ? '每周窗口' : 'Weekly window'
    case 'monthly': return zh ? '每月窗口' : 'Monthly window'
    default: return id
  }
}

/**
 * Turn one account-card failure into a sentence the reader can act on.
 *
 * The Host reports what the gateway said, which is the right thing to carry and
 * the wrong thing to show: "FreeCodeGo authentication request failed with HTTP
 * 400: invalid or expired verification code" is a log line. The shapes this card
 * can do something about are named; everything else keeps the gateway's wording
 * with the transport prefix trimmed, so the cause is the first thing read rather
 * than the fourth.
 * @param detail - the message the Host forwarded.
 * @param language - copy locale of the card.
 * @returns the line the card prints above its submit button.
 */
function describeAccountError(detail: string, language: 'zh' | 'en'): string {
  const zh = language === 'zh'
  if (/did not become available/i.test(detail)) return zh ? 'Harness Host 没有提供账号接口，请重启 Harness 后重试；若仍如此，请更新插件。' : 'The Harness Host exposes no account endpoint — restart the Harness and try again; update the plugin if it stays missing.'
  // This plugin's own response reader, not the gateway: a field it insists on
  // and the gateway did not send. Naming the field is what makes the next report
  // useful; the English sentence it throws is a log line.
  const missing = /^FreeCodeGo response (.+?) must be/i.exec(detail)?.[1]
  if (missing !== undefined) return zh ? `服务返回的账号数据缺少「${missing}」字段，插件无法完成登录。请更新插件后重试。` : `The gateway's account payload is missing \`${missing}\`, so the sign-in cannot complete. Update the plugin and try again.`
  if (/backend is not configured|backendNotConfigured/i.test(detail)) return zh ? '尚未配置 FreeCodeGo 后端地址，请先在插件设置里填写后再试。' : 'No FreeCodeGo backend is configured; set its address in the plugin settings first.'
  if (/REG_DISABLED|registration is disabled/i.test(detail)) return zh ? '当前未开放注册，请联系站点管理员或使用已有账号登录。' : 'Registration is currently disabled — ask the site owner, or sign in to an existing account.'
  if (/Invalid email/i.test(detail)) return zh ? '邮箱格式不正确，请检查后再试。' : 'That email address is not valid.'
  if (/Invalid request/i.test(detail)) return zh ? '请求被服务拒绝（字段不合法），请检查邮箱、验证码与密码后重试。' : 'The gateway rejected the request as malformed; check the address, code and password.'
  if (/invalid or expired verification code|INVALID_VERIFY_CODE/i.test(detail)) return zh ? '验证码无效或已过期。请点「发送验证码」重新获取，并确认邮箱与收验证码时填的是同一个。' : 'That verification code is invalid or expired. Send a new one, and check the address matches the one the code was sent to.'
  if (/VERIFY_CODE_TOO_FREQUENT|too frequent|rate.?limit/i.test(detail)) return zh ? '验证码发送过于频繁，请等冷却结束后再试。' : 'Verification codes are being requested too often; wait out the cooldown.'
  if (/EMAIL_EXISTS|email.*(?:already )?exists|already registered|email.*has an account/i.test(detail)) return zh ? '该邮箱已经注册过，请直接用「登录」；忘记密码可用找回密码。' : 'That email already has an account — sign in instead, or use password recovery.'
  if (/INVITATION_CODE|invitation/i.test(detail)) return zh ? '本次注册需要邀请码，请填写后重试。' : 'This registration needs an invitation code.'
  if (/turnstile/i.test(detail)) return zh ? '人机校验未通过，请稍后重试。' : 'The human-verification check did not pass; try again shortly.'
  if (/password/i.test(detail) && /(too short|min=|at least|length)/i.test(detail)) return zh ? '密码太短，至少 6 位。' : 'That password is too short — six characters is the minimum.'
  if (/ACCOUNT_LOGIN_REJECTED|invalid (?:password|credential)|incorrect password|unauthori[sz]ed|401|403/i.test(detail)) return zh ? '邮箱或密码不正确，请检查后重试。' : 'That email and password do not match an account.'
  if (/Failed to fetch|NetworkError|network|ECONN|timeout|aborted|abort/i.test(detail)) return zh ? '网络请求失败或被中断，请检查网络后重试。' : 'The request failed or was interrupted — check the connection and try again.'
  const stripped = detail.replace(/^FreeCodeGo (?:\w+ )?request failed with HTTP (\d+):?\s*/i, (_match, status: string) => `${zh ? '服务返回 HTTP' : 'the gateway answered HTTP'} ${status}${zh ? '：' : ': '}`)
  // An unrecognised failure keeps the gateway's own wording — inventing a
  // Chinese sentence for a cause we did not identify would hide the one line
  // that makes the report actionable — but it is framed in the card's language
  // so a Chinese reader is never shown a bare English error and left to guess
  // whether the click did anything.
  return zh && /[A-Za-z]{3}/.test(stripped) ? `操作未成功（${stripped}）` : stripped
}

function describeAgnesError(detail: string): string {
  if (/AGNES_VERIFICATION_RATE_LIMITED|sending too frequently/i.test(detail)) return '验证码发送过于频繁，请等待约 60 秒后再试；重复点击不会加快发送。'
  if (/AGNES_PASSWORD_RESET_UNSUPPORTED|password reset is not supported for this account/i.test(detail)) return '该 Agnes 账号不支持密码重置，通常是第三方登录或特殊账号类型；请使用原登录方式，或在 Agnes 官网处理账号。'
  if (/AGNES_LOGIN_REQUIRED/i.test(detail)) return '尚未登录 Agnes，请先登录账号。'
  if (/invalid password|password.*incorrect|incorrect.*password|密码错误/i.test(detail)) return 'Agnes 密码错误，请检查邮箱和密码后重试。'
  if (/invalid verification|verification.*invalid|验证码/i.test(detail)) return '验证码无效或已过期，请重新发送验证码。'
  return detail.replace(/^Agnes (?:request|login|registration|password reset) failed[^:]*:\s*/i, '')
}

/** Pending federated registration projected from the Host's OAUTH_REGISTRATION_REQUIRED payload. */
interface OAuthPendingRegistration {
  readonly step: 'choose-account' | 'email-completion' | 'bind-login'
  readonly email?: string
  readonly invitationRequired: boolean
  readonly emailVerified: boolean
  readonly displayName?: string
  readonly avatarUrl?: string
}

/** Parse the pending-registration detail from one OAUTH_REGISTRATION_REQUIRED message. */
function parseOAuthRegistrationRequired(detail: string): OAuthPendingRegistration | undefined {
  const marker = 'OAUTH_REGISTRATION_REQUIRED:'
  const start = detail.indexOf(marker)
  if (start < 0) return undefined
  const rest = detail.slice(start + marker.length)
  // The payload carries the original handoff state before the JSON blob in
  // the poll path; the JSON object always starts at the first "{".
  const jsonStart = rest.indexOf('{')
  if (jsonStart < 0) return undefined
  try {
    const parsed = JSON.parse(rest.slice(jsonStart)) as Record<string, unknown>
    const step = typeof parsed.step === 'string' ? parsed.step : 'choose_account_action_required'
    const normalized: OAuthPendingRegistration['step'] = step === 'email_completion' ? 'email-completion' : step === 'bind_login_required' ? 'bind-login' : 'choose-account'
    const email = typeof parsed.email === 'string' && parsed.email.trim() !== '' ? parsed.email.trim() : undefined
    const displayName = typeof parsed.suggested_display_name === 'string' && parsed.suggested_display_name.trim() !== '' ? parsed.suggested_display_name.trim() : undefined
    const avatarUrl = typeof parsed.suggested_avatar_url === 'string' && parsed.suggested_avatar_url.trim() !== '' ? parsed.suggested_avatar_url.trim() : undefined
    return {
      step: normalized,
      ...(email === undefined ? {} : { email }),
      invitationRequired: parsed.invitation_required === true,
      emailVerified: parsed.email_verified === true,
      ...(displayName === undefined ? {} : { displayName }),
      ...(avatarUrl === undefined ? {} : { avatarUrl }),
    }
  } catch {
    return undefined
  }
}

/**
 * One receipt file, as it arrives over the Remote boundary.
 *
 * `content` is the document's own text unless `encoding` says base64, which is
 * how a PDF travels: JSON cannot carry bytes, so the binary document is encoded
 * on the Host side and decoded here.
 */
interface ReceiptDocument {
  readonly fileName: string
  readonly contentType: string
  readonly content: string
  readonly encoding?: 'text' | 'base64'
}

/**
 * The document's bytes, decoded from however it travelled.
 *
 * A corrupt receipt must fail loudly rather than be saved as a file that looks
 * valid and opens as nothing, and that needs two checks because the decoder only
 * makes one of them: `atob` throws on a payload carrying characters outside the
 * alphabet (an error body handed over as a PDF), but it accepts a **non-canonical**
 * one — a trailing character whose low bits are dropped — and hands back bytes
 * that are not what the payload encoded. So the bytes are re-encoded and compared
 * with what arrived: what saves is the document the Host sent, or nothing.
 * @param document - the fetched receipt.
 * @returns the bytes to save.
 */
function receiptBytes(document: ReceiptDocument): Uint8Array<ArrayBuffer> {
  if (document.encoding !== 'base64') return new TextEncoder().encode(document.content)
  const binary = globalThis.atob(document.content)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  // Padding is dropped from both sides because `atob` accepts an unpadded
  // encoding while `btoa` always pads: comparing them verbatim would reject a
  // payload that decoded correctly.
  const padding = /=+$/u
  const arrived = document.content.replace(/\s+/gu, '').replace(padding, '')
  if (globalThis.btoa(binary).replace(padding, '') !== arrived) throw new Error('receipt base64 does not decode back to itself')
  return bytes
}

/**
 * Hand a fetched receipt to the browser as a file download.
 *
 * The bytes are the backend's own document and the filename is the backend's own
 * name, so what lands in the download folder is the receipt that was issued
 * rather than a re-drawn copy. The object URL is revoked straight away: the
 * download has already started and holding the blob alive would leak it for the
 * life of the panel.
 * @param document - the fetched receipt, in whichever encoding it arrived.
 */
export function saveReceiptDocument(document: ReceiptDocument): void {
  const blob = new Blob([receiptBytes(document)], { type: document.contentType })
  const url = URL.createObjectURL(blob)
  const anchor = globalThis.document.createElement('a')
  anchor.href = url
  anchor.download = document.fileName
  anchor.click()
  URL.revokeObjectURL(url)
}

/**
 * One order row's date, as the receipt list prints it.
 *
 * An absent or unparseable stamp drops out of the row's line rather than being
 * replaced by today's date: a payment dated as today when it was not is a wrong
 * fact, where a missing date is only an incomplete one.
 * @param order - the order row to date.
 * @returns the formatted stamp, or undefined when the row carries none.
 */
/**
 * The stamp one receipt row dates itself by.
 *
 * The payment's own time when the backend sent one, and the order's creation
 * time only as a fallback. A receipt is evidence about a payment, so the row has
 * to state when the money arrived: an order opened at 23:59 and paid at 00:01
 * was filed under the wrong day, and the reader of this list is checking exactly
 * that fact against their bank statement. The fallback stays because a row that
 * carries only `created_at` — an older backup, or a provider that echoes one
 * stamp — is still better dated than undated.
 * @param order - the row to stamp.
 * @returns the ISO stamp to render, or undefined when the row carries neither.
 */
export function orderReceiptStamp(order: Pick<PaymentOrder, 'paidAt' | 'createdAt'>): string | undefined {
  return order.paidAt ?? order.createdAt
}

function orderDateLabel(order: PaymentOrder): string | undefined {
  const stamp = orderReceiptStamp(order)
  if (stamp === undefined) return undefined
  const parsed = Date.parse(stamp)
  return Number.isFinite(parsed) ? engineeringMemoryDate(parsed) : undefined
}

/**
 * The account's paid payments, each with the receipt the backend issued.
 *
 * Opened rather than always shown, which is also how it reads its list: the
 * mount is the gesture, so the read happens when a user asks for a receipt
 * instead of on every settings render. The list is read fresh rather than taken
 * from the panel's pending-order snapshot because the row a user wants is
 * usually the payment they just made — and because the pending snapshot keeps
 * only unpaid orders, which is the one set receipts are never in.
 */
export function PaymentReceiptManager(input: {
  /** The account's orders, as the Host serves them. */
  readonly orders: () => Promise<RemoteResult<unknown>>
  /** The backend's own document for one order. */
  readonly receiptDocument: (orderId: string) => Promise<RemoteResult<ReceiptDocument>>
  /**
   * Stripe's own document for one order, when the Host offers it. Separate from
   * the receipt above because they are two issuers: a Stripe payment has both,
   * and the row offers the second only where the backend says Stripe holds one.
   */
  readonly stripeReceiptDocument?: ((orderId: string) => Promise<RemoteResult<ReceiptDocument>>) | undefined
  readonly language: 'zh' | 'en'
}): ReactNode {
  const zh = input.language === 'zh'
  const [rows, setRows] = useState<readonly PaymentOrder[] | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const load = (): void => {
    setBusy('load')
    setError(undefined)
    void input.orders().then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      // A malformed row is a failed read, not an empty one: silently dropping it
      // would report "no payments" for an account whose history we could not
      // parse — and the user would conclude their payments are gone.
      try { setRows(parseReceiptOrders(result.value)) } catch (failure: unknown) { setError(failure instanceof Error ? failure.message : String(failure)) }
    }, (failure: unknown) => { setError(failure instanceof Error ? failure.message : String(failure)) }).finally(() => { setBusy(undefined) })
  }

  // Mount-only: the disclosure that renders this panel is the refresh gesture.
  useEffect(() => { load() }, [])

  const save = (kind: 'receipt' | 'stripe', orderId: string, fetch: (orderId: string) => Promise<RemoteResult<ReceiptDocument>>): void => {
    setBusy(`${kind}:${orderId}`)
    setError(undefined)
    setNotice(undefined)
    void fetch(orderId).then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      try {
        saveReceiptDocument(result.value)
        setNotice(zh ? `已保存 ${result.value.fileName}。` : `Saved ${result.value.fileName}.`)
      } catch (failure: unknown) {
        // The document was fetched, so this is a decode failure rather than a
        // network one. Saying which keeps a user from retrying a download that
        // will fail the same way, and keeps a broken file off their disk.
        const reason = failure instanceof Error ? failure.message : String(failure)
        setError(zh ? `收据文件无法解读：${reason}` : `The receipt file could not be read: ${reason}`)
      }
    }, (failure: unknown) => { setError(failure instanceof Error ? failure.message : String(failure)) }).finally(() => { setBusy(undefined) })
  }

  return <div className={css.accountManager}>
    <div className={css.accountActions}>
      <button className={css.button} type="button" onClick={load} disabled={busy !== undefined}>{busy === 'load' ? (zh ? '读取中…' : 'Loading…') : (zh ? '刷新支付记录' : 'Refresh payments')}</button>
    </div>
    <small className={css.sectionMeta}>{zh ? '每一笔已支付的充值订单都可以下载收据；信用卡支付的订单还可以下载一份 PDF 付款凭证。' : 'Every paid recharge order offers a receipt; a payment taken by card also offers a PDF payment document.'}</small>
    {error === undefined ? null : <small className={css.sectionMeta}>{error}</small>}
    {notice === undefined ? null : <small className={css.sectionMeta}>{notice}</small>}
    {busy === 'load' && rows === undefined ? <small className={css.sectionMeta}>{zh ? '正在读取支付记录…' : 'Loading payments…'}</small> : null}
    {rows === undefined ? null : rows.length === 0
      ? <small className={css.sectionMeta}>{zh ? '这个账户还没有可下载收据的支付记录。' : 'No payment on this account has a receipt yet.'}</small>
      : <div className={css.accountList}>
        {rows.map(order => <div className={css.accountRow} key={order.orderId}>
          <div className={css.accountIdentity}>
            {/* What the payer paid, in the currency they paid it in. `amount` is
                the credit side and is always USD, so the two are never mixed: a
                settle amount is only quoted in its own currency. */}
            <strong className={css.accountName}>{order.payAmount === undefined ? formatMoney(order.amount, 'USD') : formatMoney(order.payAmount, orderSettlementCurrency(order) ?? 'USD')}</strong>
            {/* The state is the backend's token said in the reader's language, through
                the same table the payment dialog uses: the panel was printing `PAID`
                beside a dialog saying `已支付` for the same order. A token the table
                does not know still comes through as the backend spelled it. */}
            <small className={css.accountEmail}>{[orderDateLabel(order), `#${order.orderId}`, orderStateLabel(order.state, zh), ...(order.paymentType === undefined ? [] : [paymentChannelLabel(order.paymentType, input.language)])].filter(part => part !== undefined).join(' · ')}</small>
          </div>
          <div className={css.accountActions}>
            <button className={css.button} type="button" onClick={() => { save('receipt', order.orderId, input.receiptDocument) }} disabled={busy !== undefined}>{busy === `receipt:${order.orderId}` ? (zh ? '下载中…' : 'Downloading…') : (zh ? '下载收据' : 'Download receipt')}</button>
            {/* Offered only where the backend says Stripe holds one: the row itself
                knows, so a button that would answer "not available" is never drawn.
                The rule is shared with the open order's card (`stripeReceiptOffered`),
                so the two surfaces cannot offer different sets. */}
            {!stripeReceiptOffered(order, input.stripeReceiptDocument) ? null : <button className={css.button} type="button" onClick={() => { save('stripe', order.orderId, input.stripeReceiptDocument!) }} disabled={busy !== undefined}>{busy === `stripe:${order.orderId}` ? (zh ? '下载中…' : 'Downloading…') : (zh ? '下载付款凭证' : 'Download payment document')}</button>}
          </div>
        </div>)}
      </div>}
  </div>
}

/**
 * Everything the in-panel payment dialog renders, captured when it opens.
 *
 * Snapshotting is what lets the dialog live outside the panel's `ready` gate:
 * the payment it represents outlives any one read of the account.
 */
interface OpenPaymentDialog {
  readonly order: PaymentDialogOrder
  readonly channel: PaymentChannel | undefined
  readonly publishableKey: string | undefined
  readonly receiptEmail: string | undefined
  readonly payCurrency: string | undefined
}

export function FreeCodeGoSettingsTab({ catalog, accountStatus, accountRememberedPassword, login, register, sendVerifyCode, forgotPassword, resetPassword, oauthLogin, oauthPendingSendVerifyCode, oauthPendingBind, oauthPendingCreate, completeMfa, logout, deviceSessions, revokeDeviceSession, revokeAllSessions, setDefaultModel, setDefaultEngine, backendCatalog, readMediaDefaults, nativeModelCatalog, pickerModelDirectory, currentSessionId, vyceStatus, vyceSetKey, logfareStatus, logfareRegister, logfareSetTrainingOptIn, logfareSetKey, accountDetail, sensenovaStatus, sensenovaSetKey, nvidiaStatus, nvidiaSetKey, useConnectionEpoch, paymentPlans, paymentChannels, paymentConfig, gatewayModelPrices, paymentCheckout, paymentOrder, paymentVerify, paymentCancel, paymentReceiptEmail, paymentReceiptDocument, paymentStripeReceiptDocument, paymentOrders, agnesStatus, agnesSendVerification, agnesSendPasswordReset, agnesResetPassword, agnesLogin, agnesRegister, agnesLogout, agnesRemoveAccount, agnesRefresh, agnesCreateApiKey, clineStatus, clineStartLogin, clinePollLogin, clineAddAccount, clineRemoveAccount, clineRefresh, clineLogout, workbuddyStatus, workbuddyImportDesktopLogin, workbuddyStartBrowserLogin, workbuddyPollBrowserLogin, workbuddyLogout, workbuddyRemoveAccount, workbuddyRefreshCredits, qoderStatus, qoderStartBrowserLogin, qoderPollBrowserLogin, qoderLogout, qoderRemoveAccount, qoderSetActiveAccount, qoderRefreshQuota, qoderCheckin: runQoderCheckin, traeStatus, traeStartBrowserLogin, traePollBrowserLogin, traeSubmitCallback, traeCancelBrowserLogin, traeModels: loadTraeModels, traeLogout, traeRemoveAccount, traeSetActiveAccount, traeCheckin: runTraeCheckin, codexRuntimeStatus, codexRuntimePackages, codexRuntimeInstall, codexRuntimeRemove, claudeRuntimeStatus, claudeRuntimePackages, claudeRuntimeInstall, claudeRuntimeRemove, pluginUpdateStatus, pluginUpdateCheck, pluginUpdateSetEnabled, pluginUpdateInstall, pluginUpdateRollback, communityCatalog, communityCatalogIcons, communityEnvironment, communityInstalled, communityInstall, communityUninstall, capabilityMarketplace, mcpPresetInstall, skillPresetInstall, skillPresetRemove, skillPlacements, skillPlacementPrefer, capabilities, readLocalCapabilities, capabilitiesSetEnabled, setLocalCapability, setModelCategoryDirect, modelCategorySet, pluginConflictStatus, pluginConflictSetEnabled, headroomStatus, headroomSetEnabled, headroomUpdate, deferredToolsStatus, deferredToolsSetEnabled, mediaGenerationStatus, mediaGenerationSetEnabled, reviewStatus, reviewStart, reviewUpdate, guardSettingsStatus, guardSettingsUpdate, workbuddySetActiveAccount, automationSettingsStatus, automationSettingsUpdate, sandboxModeStatus, sandboxModeSet, trustFolderStatus, trustFolderGrant, trustFolderRevoke, projectConfigReport, advisorStatus, advisorUpdate, engineeringStatus, engineeringSetEnabled, language, t }: Props): ReactNode {
  const [state, setState] = useState<State>(() => cachedSettings(language, catalog)?.state ?? { ...fallbackSettings(), syncStatus: 'refreshing' })
  // A fresh catalog render must not infer media defaults until the Host has
  // returned the durable values. Otherwise the first available model can race
  // the read and overwrite a user's saved image/video/audio selection.
  const [mediaDefaultsSource, setMediaDefaultsSource] = useState<MediaDefaultsSource>(readMediaDefaults === undefined ? 'document' : 'pending')
  const [pluginUpdateSnapshot, setPluginUpdateSnapshot] = useState<FreeCodeGoPluginUpdateStatus | undefined>(undefined)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [rememberLogin, setRememberLogin] = useState(false)
  /** The password box: a user who cannot see what a hardened field accepts types
   * it twice and guesses at the difference. The reveal is per mount and reset
   * with the field, so a revealed password never outlives the sign-in attempt. */
  const [passwordVisible, setPasswordVisible] = useState(false)
  /** Mirrors what the Host credential file holds, not a wish: it is set from the
   * remembered-password read and committed by the next sign-in. */
  const [rememberPassword, setRememberPassword] = useState(false)
  const [verifyCode, setVerifyCode] = useState('')
  // The account card is a two-mode surface: sign in, or create the account
  // with an emailed code. Splitting them keeps the login form to the two
  // fields it actually needs instead of showing the registration controls.
  const [authTab, setAuthTab] = useState<'login' | 'register'>('login')
  const [verifyCooldown, setVerifyCooldown] = useState(0)
  const [verifySending, setVerifySending] = useState(false)
  const [oauthBusy, setOauthBusy] = useState<FreeCodeGoOAuthProvider | undefined>(undefined)
  const [oauthNotice, setOauthNotice] = useState<string | undefined>(undefined)
  /**
   * The account card's own failure line, drawn beside the button that produced it.
   *
   * The panel-wide `actionError` renders at the top of this tab, above the page
   * tabs, and this card sits well below them: a rejected registration therefore
   * put its reason on a line the reader had already scrolled past, which is
   * indistinguishable from a button that does nothing. Same reasoning as
   * `checkoutError` further down, and the same class of defect.
   */
  const [authNotice, setAuthNotice] = useState<string | undefined>(undefined)
  /** Which credential form is in flight, so its own button says so and refuses a second press. */
  const [authBusy, setAuthBusy] = useState<'login' | 'register' | undefined>(undefined)
  /**
   * Password recovery, opened from the login form.
   *
   * It is a mode of the card rather than a third tab: recovery is something the
   * sign-in form offers when it did not work, and putting it beside 登录/注册 as
   * an equal would invite it from people who know their password.
   */
  const [resetOpen, setResetOpen] = useState(false)
  const [resetCode, setResetCode] = useState('')
  const [resetSecret, setResetSecret] = useState('')
  const [resetSending, setResetSending] = useState(false)
  const [resetBusy, setResetBusy] = useState(false)
  const [resetCooldown, setResetCooldown] = useState(0)
  // Pending federated registration: the browser sign-in ended without an
  // account match, so the user completes it here (bind or create).
  const [oauthPending, setOauthPending] = useState<OAuthPendingRegistration | undefined>(undefined)
  const [oauthPendingMode, setOauthPendingMode] = useState<'bind' | 'create'>('create')
  const [oauthPendingEmail, setOauthPendingEmail] = useState('')
  const [oauthPendingPassword, setOauthPendingPassword] = useState('')
  const [oauthPendingTotpCode, setOauthPendingTotpCode] = useState('')
  const [oauthPendingVerifyCode, setOauthPendingVerifyCode] = useState('')
  const [oauthPendingInvitation, setOauthPendingInvitation] = useState('')
  const [oauthPendingBusy, setOauthPendingBusy] = useState(false)
  const [oauthPendingVerifyCooldown, setOauthPendingVerifyCooldown] = useState(0)
  const [totpCode, setTotpCode] = useState('')
  const [paymentType, setPaymentType] = useState('')
  const [priceQuery, setPriceQuery] = useState('')
  const [checkoutPending, setCheckoutPending] = useState(false)
  /**
   * The order a checkout click created, plus everything the payment dialog needs
   * to draw it.
   *
   * The settings the dialog reads are *copied here at open time* rather than read
   * from `state` on every render, because a payment is an interruption: the panel
   * re-reads account, plans and channels on a timer, and any one of those reloads
   * can leave `state` briefly not-ready. Reading the live state meant the dialog
   * (and the card form inside it) unmounted mid-payment and took the user's
   * half-filled card details with it.
   */
  const [paymentDialog, setPaymentDialog] = useState<OpenPaymentDialog | undefined>(undefined)
  /** Checkout failures, rendered next to the plan grid instead of at the panel top. */
  const [checkoutError, setCheckoutError] = useState<string | undefined>(undefined)
  const checkoutLock = useRef(false)
  const autoLoginAttempted = useRef(false)
  const [codexStatus, setCodexStatus] = useState<{ installed: boolean; platform: string; runtimeVersion?: string; reason?: string } | undefined>(undefined)
  const [codexBusy, setCodexBusy] = useState(false)
  const [codexPackages, setCodexPackages] = useState<readonly RuntimePackage[]>([])
  const [claudePackages, setClaudePackages] = useState<readonly RuntimePackage[]>([])
  const [runtimePicker, setRuntimePicker] = useState<'codex' | 'claude' | undefined>(undefined)
  const [claudeStatus, setClaudeStatus] = useState<{ installed: boolean; platform: string; runtimeVersion?: string; reason?: string } | undefined>(undefined)
  const [claudeBusy, setClaudeBusy] = useState(false)
  const [vyceKey, setVyceKey] = useState('')
  const [vyceBusy, setVyceBusy] = useState(false)
  const [logfareRegisterBusy, setLogfareRegisterBusy] = useState(false)
  const [logfareTrainingBusy, setLogfareTrainingBusy] = useState(false)
  const [logfareKey, setLogfareKey] = useState('')
  const [logfareKeyBusy, setLogfareKeyBusy] = useState(false)
  const [clineToken, setClineToken] = useState('')
  const [diagnostics, setDiagnostics] = useState<FreeCodeGoBackendSnapshot | undefined>(undefined)
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false)
  /** The receipt list's disclosure. Closed on mount like every other panel here:
   * the read it triggers is a request per order state, so it waits to be asked. */
  const [receiptsOpen, setReceiptsOpen] = useState(false)
  const [sensenovaKey, setSensenovaKey] = useState('')
  const [sensenovaBusy, setSensenovaBusy] = useState(false)
  const [nvidiaKey, setNvidiaKey] = useState('')
  const [nvidiaBusy, setNvidiaBusy] = useState(false)
  const [agnesEmail, setAgnesEmail] = useState('')
  const [agnesPassword, setAgnesPassword] = useState('')
  const [agnesCode, setAgnesCode] = useState('')
  const [agnesManagerOpen, setAgnesManagerOpen] = useState(false)
  const [agnesResetOpen, setAgnesResetOpen] = useState(false)
  const [agnesResetEmail, setAgnesResetEmail] = useState('')
  const [agnesResetPasswordValue, setAgnesResetPasswordValue] = useState('')
  const [agnesResetConfirm, setAgnesResetConfirm] = useState('')
  const [agnesResetCode, setAgnesResetCode] = useState('')
  const [agnesRegisterCooldown, setAgnesRegisterCooldown] = useState(0)
  const [agnesResetCooldown, setAgnesResetCooldown] = useState(0)
  const [modelCategory, setModelCategory] = useState<ModelCategory>('text')
  const [modelMoveCandidate, setModelMoveCandidate] = useState('')
  const [settingsPage, setSettingsPage] = useState<'overview' | 'providers' | 'community' | 'settings'>('overview')
  const [capabilitySnapshot, setCapabilitySnapshot] = useState<CapabilitySnapshot | undefined>(undefined)
  const [capabilitiesLoaded, setCapabilitiesLoaded] = useState(capabilities === undefined)
  const [nativeModels, setNativeModels] = useState<readonly NativeCatalogModel[]>([])
  const [nativeCatalogEpoch, setNativeCatalogEpoch] = useState(0)
  const [pickerRows, setPickerRows] = useState<readonly { readonly provider: string; readonly id: string; readonly label: string; readonly description?: string }[]>([])
  const [advisorSnapshot, setAdvisorSnapshot] = useState<AdvisorSnapshot | undefined>(undefined)
  const [advisorToggleBusy, setAdvisorToggleBusy] = useState(false)
  const [engineeringSnapshot, setEngineeringSnapshot] = useState<EngineeringStatus | undefined>(undefined)
  const [engineeringToggleBusy, setEngineeringToggleBusy] = useState(false)
  const loadGeneration = useRef(0)
  const mediaDefaultsReadGeneration = useRef(0)
  const syncRetryAttempt = useRef(0)
  const syncRetryTimer = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined)
  const mediaDefaultsInitialized = useRef(new Set<Exclude<ModelCategory, 'text'>>())
  const mediaDefaultsPending = useRef(new Set<Exclude<ModelCategory, 'text'>>())
  useEffect(() => () => { mediaDefaultRetryAfter.clear() }, [])
  const connectionEpoch = useConnectionEpoch(value => value)
  const nativeModelSessionId = currentSessionId?.()
  const observedConnectionEpoch = useRef(connectionEpoch)
  const selectedPaymentType = state.status === 'ready' && state.channels.some(channel => channel.paymentType === paymentType)
    ? paymentType
    : state.status === 'ready' ? state.channels[0]?.paymentType ?? '' : ''
  const effectiveCatalog = state.status === 'ready'
    ? withNativeMediaModels(withProviderAvailability(state.managedCatalog, state.logfare?.configured === true, state.logfare?.premiumUnlocked === true), nativeModels, capabilitySnapshot?.modelCategories ?? {})
    : emptyManagedCatalog
  const categoryModels = effectiveCatalog.models.filter(model => model.availability === 'available' && modelCategoryOf(model, capabilitySnapshot?.modelCategories) === modelCategory)
  const categoryProviderGroups = modelGroupRows(categoryModels, effectiveCatalog.groups)
  // Provider-card rosters. Every one is resolved from live data at render time:
  // the page used to print hand-typed name lists beside live counts, so the two
  // disagreed the moment a provider rotated its directory.
  const providerModelNames = (provider: string, category?: ModelCategory): readonly string[] =>
    nativeModels
      .filter(model => model.provider.toLowerCase() === provider)
      .filter(model => category === undefined || (capabilitySnapshot?.modelCategories?.[model.key] ?? inferredModelCategory(model.provider, model.id, model.displayName)) === category)
      .map(model => model.displayName)
  const logfareModelNames = [...(state.status === 'ready' ? state.logfare?.standardModelNames ?? [] : []), ...(state.status === 'ready' ? state.logfare?.premiumModelNames ?? [] : [])]
  const vyceModelNames = (state.status === 'ready' ? state.vyce?.models ?? [] : []).map(model => model.id)
  // The Cline card reads the same live recommendation feed the adapter serves,
  // so a newly free model shows up in the card without a catalog refresh. The
  // feed is live-only: when it cannot be reached the cloud stays empty rather
  // than advertising model ids the upstream may no longer serve.
  const clineModelNames = (state.status === 'ready' ? state.cline?.freeModels ?? [] : []).map(model => model.name)
  // A pool where an account is parked or dead still signs in, but part of its
  // directory cannot serve; the summary and the notice should say so. A route
  // park counts: that model is out even though its account is fine.
  const clineAccountStates = state.status === 'ready' && state.cline?.status === 'authenticated'
    ? state.cline.accounts.map(account => clineAccountState(account))
    : []
  // Only an account-level problem may read as "account unavailable"; a spent
  // model budget is a model problem and is reported as one.
  const clinePoolBlocked = clineAccountStates.some(entry => entry.status !== 'active')
  const clinePoolDegraded = clinePoolBlocked || clineAccountStates.some(entry => entry.coolingModels.length > 0)
  // WorkBuddy International mirrors the Cline pool shape: the card lists the
  // live free-model feed and the configured accounts, live-only.
  const workbuddyModelNames = (state.status === 'ready' ? state.workbuddy?.freeModels ?? [] : []).map(model => model.displayName)
  const workbuddyAuthenticated = state.status === 'ready' && state.workbuddy?.configured === true && (state.workbuddy.accounts?.length ?? 0) > 0
  // The card states the pool's standing; each account card below states its
  // own. Accounts whose credits could not be read are counted separately rather
  // than folded in as zeroes.
  const workbuddyAccounts = state.status === 'ready' ? state.workbuddy?.accounts ?? [] : []
  const workbuddyCreditTotals = workbuddyAccounts.reduce((totals, account) => {
    const credits = account.credits
    if (credits === undefined || credits.error !== undefined) return totals
    return { remaining: totals.remaining + credits.remaining, total: totals.total + credits.total, known: totals.known + 1 }
  }, { remaining: 0, total: 0, known: 0 })
  const workbuddyCreditSummary = workbuddyCreditTotals.known === 0
    ? undefined
    : language === 'zh'
      ? `积分剩余 ${formatCredits(workbuddyCreditTotals.remaining)} / ${formatCredits(workbuddyCreditTotals.total)}`
      : `${formatCredits(workbuddyCreditTotals.remaining)} / ${formatCredits(workbuddyCreditTotals.total)} credits left`
  const workbuddyPoolNote = workbuddyAccounts.length === 0
    ? undefined
    : language === 'zh'
      ? `已登录 ${workbuddyAccounts.length} 个账号 · 额度每 30 分钟自动刷新一次`
      : `${workbuddyAccounts.length} accounts · credits refresh every 30 min`
  // Trae signs in through a browser round trip the Host owns, so the card reads
  // the attempt out of the status rather than out of local ticket state: one
  // `login-pending` value is both "accounts still show" and "keep polling".
  const traeAccounts = state.status === 'ready' ? state.trae?.accounts ?? [] : []
  const traeAuthenticated = state.status === 'ready' && (state.trae?.status === 'authenticated' || state.trae?.status === 'reauth-required')
  const traeLoginPending = state.status === 'ready' && state.trae?.status === 'login-pending' ? state.trae : undefined
  const traePending = traeLoginPending !== undefined
  const traeCnCount = traeAccounts.filter(account => account.realm === 'cn').length
  const traeGlobalCount = traeAccounts.length - traeCnCount
  // Qoder serves a single free route from the Host account pool.
  const qoderModelNames = (state.status === 'ready' ? state.qoder?.freeModels ?? [] : []).map(model => model.displayName)
  const qoderAuthenticated = state.status === 'ready' && state.qoder?.configured === true && (state.qoder.accounts?.length ?? 0) > 0
  const qoderAccounts = state.status === 'ready' ? state.qoder?.accounts ?? [] : []
  const qoderQuotaLine = (quota: NonNullable<QoderStatus['accounts'][number]['quota']>): string => {
    if (quota.error !== undefined) return language === 'zh' ? `额度读取失败：${quota.error}` : `Quota unavailable: ${quota.error}`
    const bucket = quota.userQuota ?? quota.addonQuota
    if (bucket === undefined) return language === 'zh' ? '暂无额度数据' : 'No quota data'
    return language === 'zh'
      ? `额度剩余 ${formatCredits(bucket.remaining)} / ${formatCredits(bucket.total)}`
      : `${formatCredits(bucket.remaining)} / ${formatCredits(bucket.total)} left`
  }
  // Under the native picker the text-model default can only be chosen from a
  // listed native model. Cline is not in that directory, so a blank default for
  // the text category is the honest binding; the pickable model list no longer
  // advertises a fake local model to stand in for it.
  const sensenovaModelNames = providerModelNames('sensenova', 'text')
  const nvidiaModelNames = providerModelNames('nvidia', 'text')
  // Agnes media routes are excluded: they belong to the media-default picker,
  // not to the chat model list this card describes.
  const agnesModelNames = providerModelNames('agnes', 'text')
  // The picker's own directory, grouped for the per-provider visibility controls.
  // These are the rows the chat menu renders, not the card's hand-picked cloud:
  // the question the panel answers is "what does the model list show", so it has
  // to be built from the list itself. The id is carried beside the label because
  // a decision is stored against the id — a label is display text and two
  // providers may render one name twice.
  const pickerModelsFor = (provider: string): readonly ProviderPickerModel[] =>
    pickerRows.length === 0
      // The live directory is the authority; the Host projection is the
      // fallback for a client that has no session bound yet.
      ? nativeModels.filter(model => model.provider.toLowerCase() === provider).map(model => ({ id: model.id, label: model.displayName }))
      : pickerRows.filter(model => model.provider.toLowerCase() === provider).map(model => ({
        id: model.id,
        label: model.label,
        ...(model.description === undefined ? {} : { description: model.description }),
      }))
  // One card per provider, one control per card. Built here rather than spelled
  // out seven times so the cards cannot drift into seven slightly different
  // controls, and so the call site stays short enough to read.
  // A getter rather than an array: the panel re-reads it while the directory is
  // still arriving, and the call site stays a one-liner.
  const providerVisibility = (provider: string): ReactNode =>
    <ProviderModelVisibility provider={provider} models={() => pickerModelsFor(provider)} language={language} />
  // The select binds to the stored default for the active category; an empty
  // binding means nothing is stored, which is the only case that needs a
  // placeholder option (a value not backed by an option renders blank).
  const selectedCategoryModel = state.status === 'ready'
    ? modelCategory === 'text' ? state.catalog.defaultModel ?? '' : state.catalog.mediaDefaults?.[modelCategory] ?? ''
    : ''
  // A default the current catalog does not offer is still the stored default:
  // the select renders it as its own row rather than falling back to the first
  // option, which is what made the panel look like it had forgotten a choice it
  // had in fact kept.
  const categorySelection = pickSelection(selectedCategoryModel, categoryProviderGroups)
  const categoryMoveCandidates = (() => {
    const candidates = new Map<string, { readonly key: string; readonly providerName: string; readonly displayName: string; readonly category: ModelCategory }>()
    for (const model of nativeModels) {
      candidates.set(model.key, { key: model.key, providerName: model.providerName, displayName: model.displayName, category: capabilitySnapshot?.modelCategories?.[model.key] ?? inferredModelCategory(model.provider, model.id, model.displayName) })
    }
    // The native directory can be empty while a session is still loading. The
    // managed catalog is already available in that state, so expose it as a
    // migration source instead of rendering an always-empty select.
    for (const model of effectiveCatalog.models) {
      const key = modelCategoryKey(model.provider, model.id)
      if (candidates.has(key)) continue
      candidates.set(key, { key, providerName: mediaProviderName(model), displayName: cleanModelDisplayName(model.displayName, visibleModelId(model.provider, model.id)), category: modelCategoryOf(model, capabilitySnapshot?.modelCategories) })
    }
    return [...candidates.values()]
  })()
  useEffect(() => {
    const refresh = (): void => { setNativeCatalogEpoch(value => value + 1) }
    globalThis.addEventListener('fcg:model-catalog-updated', refresh)
    return () => { globalThis.removeEventListener('fcg:model-catalog-updated', refresh) }
  }, [])
  useEffect(() => {
    const onCapabilitiesChanged = (event: Event): void => {
      if (event instanceof CustomEvent) setCapabilitySnapshot(event.detail as CapabilitySnapshot)
    }
    globalThis.addEventListener(CAPABILITY_CHANGE_EVENT, onCapabilitiesChanged)
    return () => { globalThis.removeEventListener(CAPABILITY_CHANGE_EVENT, onCapabilitiesChanged) }
  }, [])
  useEffect(() => {
    const onAdvisorChanged = (event: Event): void => {
      if (event instanceof CustomEvent) setAdvisorSnapshot(event.detail as AdvisorSnapshot)
    }
    globalThis.addEventListener(ADVISOR_CHANGE_EVENT, onAdvisorChanged)
    return () => { globalThis.removeEventListener(ADVISOR_CHANGE_EVENT, onAdvisorChanged) }
  }, [])
  useEffect(() => {
    const onEngineeringChanged = (event: Event): void => {
      if (event instanceof CustomEvent) setEngineeringSnapshot(event.detail as EngineeringStatus)
    }
    globalThis.addEventListener(ENGINEERING_CHANGE_EVENT, onEngineeringChanged)
    return () => { globalThis.removeEventListener(ENGINEERING_CHANGE_EVENT, onEngineeringChanged) }
  }, [])
  useEffect(() => {
    if (advisorStatus === undefined) return
    let active = true
    void advisorStatus().then((result) => { if (active && result.ok) setAdvisorSnapshot(result.value) }, ignoreRejection)
    return () => { active = false }
  }, [advisorStatus, connectionEpoch])
  useEffect(() => {
    if (engineeringStatus === undefined) return
    let active = true
    void engineeringStatus().then((result) => { if (active && result.ok) setEngineeringSnapshot(result.value) }, ignoreRejection)
    return () => { active = false }
  }, [engineeringStatus, connectionEpoch])
  useEffect(() => {
    if (typeof globalThis.localStorage === 'undefined') return
    try {
      const saved = readRememberedLogin()
      if (saved !== undefined) {
        setEmail(saved.email)
        setRememberLogin(true)
      }
    } catch (error) { setState(failed(error instanceof Error ? error.message : String(error))) }
  }, [])
  /**
   * Prefill the password the Host remembers for this machine.
   *
   * The Host is the only place it can live — the browser store holds the address
   * and nothing else — so it is read once per mount. A failed or empty read is
   * reported as nothing remembered, which is the same state as a machine nobody
   * ever asked: the field stays empty and the box unticked, rather than a
   * convenience turning into an error on the sign-in card.
   */
  useEffect(() => {
    if (accountRememberedPassword === undefined) return
    let active = true
    void accountRememberedPassword().then((result) => {
      if (!active || !result.ok) return
      const remembered = result.value.password
      if (remembered === undefined || remembered === '') return
      setPassword(remembered)
      setRememberPassword(true)
    }, () => undefined)
    return () => { active = false }
  }, [accountRememberedPassword])
  useEffect(() => {
    if (agnesRegisterCooldown === 0 && agnesResetCooldown === 0 && verifyCooldown === 0 && oauthPendingVerifyCooldown === 0 && resetCooldown === 0) return
    const timer = globalThis.setInterval(() => {
      setAgnesRegisterCooldown(value => Math.max(0, value - 1))
      setAgnesResetCooldown(value => Math.max(0, value - 1))
      setVerifyCooldown(value => Math.max(0, value - 1))
      setOauthPendingVerifyCooldown(value => Math.max(0, value - 1))
      setResetCooldown(value => Math.max(0, value - 1))
    }, 1000)
    return () => { globalThis.clearInterval(timer) }
  }, [agnesRegisterCooldown, agnesResetCooldown, verifyCooldown, oauthPendingVerifyCooldown, resetCooldown])
  useEffect(() => {
    if (selectedPaymentType !== '' && paymentType !== selectedPaymentType) setPaymentType(selectedPaymentType)
  }, [paymentType, selectedPaymentType])
  useEffect(() => () => {
    if (syncRetryTimer.current !== undefined) globalThis.clearTimeout(syncRetryTimer.current)
  }, [])
  const load = (force = false, silent = false): void => {
    const generation = ++loadGeneration.current
    const clearSyncRetry = (): void => {
      syncRetryAttempt.current = 0
      if (syncRetryTimer.current !== undefined) globalThis.clearTimeout(syncRetryTimer.current)
      syncRetryTimer.current = undefined
    }
    const scheduleSyncRetry = (): void => {
      if (syncRetryTimer.current !== undefined) return
      const attempt = syncRetryAttempt.current++
      const delay = Math.min(60_000, 5_000 * 2 ** Math.min(attempt, 4))
      syncRetryTimer.current = globalThis.setTimeout(() => {
        syncRetryTimer.current = undefined
        load(true, true)
      }, delay)
    }
    // An updater is accepted because one commit has to read state that is newer
    // than the snapshot this refresh started from — see the catalog merge below.
    const commit = (next: State | ((previous: State) => State)): void => {
      if (generation !== loadGeneration.current) return
      setState((previous) => {
        const value = typeof next === 'function' ? next(previous) : next
        if (value.status === 'ready') saveSettingsCache(language, catalog, value)
        return value
      })
    }
    const cached = force ? undefined : cachedSettings(language, catalog)
    if (cached !== undefined) {
      commit(cached.state)
      // The cache strips account details for privacy. A stale sign-out block
      // must not present a logged-in user with a login form: the account
      // identity is refreshed immediately (silently) after committing.
      if (Date.now() - cached.savedAt >= SETTINGS_CACHE_TTL_MS || cached.state.account.status !== 'authenticated') {
        load(true, true)
      }
      return
    }
    const retained = state.status === 'ready' ? state : fallbackSettings()
    const offline = (detail: string): void => { if (!silent) commit({ ...retained, syncStatus: 'offline', syncError: detail }) }
    const refreshGatewayPrices = (): void => {
      if (gatewayModelPrices === undefined) return
      void gatewayModelPrices(language).then((result) => {
        if (generation !== loadGeneration.current) return
        setState((previous) => {
          if (previous.status !== 'ready') return previous
          // A successful read must clear the previous failure. Keeping the old
          // message made one transient outage pin "pricing unavailable" on screen
          // for the whole life of the panel, even after prices came back.
          const next = result.ok
            ? { ...previous, gatewayPrices: result.value, gatewayPricingError: undefined }
            : { ...previous, gatewayPricingError: result.error.message }
          saveSettingsCache(language, catalog, next)
          return next
        })
      }, (error: unknown) => {
        if (generation !== loadGeneration.current) return
        setState((previous) => {
          if (previous.status !== 'ready') return previous
          const next = { ...previous, gatewayPricingError: error instanceof Error ? error.message : String(error) }
          saveSettingsCache(language, catalog, next)
          return next
        })
      })
    }
    const { syncError: _previousSyncError, ...refreshing } = retained
    if (!silent) commit({ ...refreshing, syncStatus: 'refreshing' })
    void (async () => {
      const [catalogResult, accountResult] = await Promise.all([
        catalog().catch((error: unknown) => ({ ok: false as const, error: { message: error instanceof Error ? error.message : String(error) } })),
        accountStatus().catch((error: unknown) => ({ ok: false as const, error: { message: error instanceof Error ? error.message : String(error) } })),
      ])
      if (!catalogResult.ok) {
        scheduleSyncRetry()
        offline(catalogResult.error.message); return
      }
      const localCatalog = catalogResult.value
      // A gateway identity refresh can fail while independently stored
      // provider credentials remain perfectly usable. Do not turn that one
      // network error into an apparent sign-out for every provider.
      const account = accountResult.ok
        ? accountResult.value
        : expiredCredential(accountResult.error.message)
          ? { status: 'reauth-required' as const }
          // A first read that failed must not leave the panel parked on the
          // pre-read placeholder: the sync error already reports the failure, and
          // a state the user cannot act on is worse than the login form it
          // replaced.
          : retained.account.status === 'loading' ? { status: 'signed-out' as const } : retained.account
      const accountSyncError = accountResult.ok ? undefined : accountResult.error.message
      if (accountResult.ok) clearSyncRetry()
      else scheduleSyncRetry()
      const { syncStatus: _previousSyncStatus, syncError: _previousSyncError, actionError: _previousActionError, ...ready } = retained
      // The Host catalog intentionally contains engine/model metadata only, so
      // this commit must not be the thing that decides which media default the
      // panel shows. It carries the *live* one rather than the value this
      // refresh started from: the settings-document read can land while the
      // refresh is in flight, and restoring the snapshot then erased the read
      // and left the panel showing the cached model — the same symptom as a
      // selection that did not stick.
      commit((previous) => {
        const mediaDefaults = (previous.status === 'ready' ? previous.catalog.mediaDefaults : undefined) ?? localCatalog.mediaDefaults
        return {
          ...ready,
          catalog: { ...localCatalog, ...(mediaDefaults === undefined ? {} : { mediaDefaults }) },
          account,
          ...(accountSyncError === undefined ? {} : { syncStatus: 'offline' as const, syncError: accountSyncError }),
        }
      })
      refreshGatewayPrices()
      const patchReady = (patch: Partial<ReadyState>): void => {
        if (generation !== loadGeneration.current) return
        setState((previous) => {
          if (previous.status !== 'ready') return previous
          const next = { ...previous, ...patch }
          saveSettingsCache(language, catalog, next)
          return next
        })
      }
      const refreshRemote = <T,>(
        call: (() => Promise<RemoteResult<T>>) | undefined,
        apply: (value: T) => void,
        reject?: (error: unknown) => void,
        retries = 0,
      ): void => {
        if (call === undefined) return
        let attempt = 0
        const run = (): void => {
          try {
            void call().then((result) => {
              if (result.ok) {
                // `apply` computes patches synchronously and can throw on a
                // malformed payload; an unobserved throw here would become an
                // unhandled rejection with no UI trace.
                try { apply(result.value) } catch (applyError) {
                  reject?.(applyError)
                }
                return
              }
              if (attempt++ < retries) { globalThis.setTimeout(run, attempt * 1_200); return }
              reject?.(result.error.message)
            }, (error: unknown) => {
              if (attempt++ < retries) { globalThis.setTimeout(run, attempt * 1_200); return }
              reject?.(error)
            })
          } catch (error) {
            if (attempt++ < retries) { globalThis.setTimeout(run, attempt * 1_200); return }
            reject?.(error)
          }
        }
        run()
      }
      refreshRemote(agnesStatus, (agnes) => { patchReady({ agnes }) })
      refreshRemote(clineStatus, (cline) => { patchReady({ cline }) })
      refreshRemote(workbuddyStatus, (workbuddy) => { patchReady({ workbuddy }) })
      refreshRemote(qoderStatus, (qoder) => { patchReady({ qoder }) })
      refreshRemote(traeStatus, (trae) => { patchReady({ trae }) })
      refreshRemote(vyceStatus, (vyce) => { patchReady({ vyce }) })
      refreshRemote(logfareStatus, (logfare) => {
        patchReady({ logfare })
        refreshRemote(backendCatalog, (managedCatalog) => { patchReady({ managedCatalog: withAgnesModels(managedCatalog) }) }, () => undefined)
      }, (error) => {
        if (unavailableRemoteMethod(error)) patchReady({ logfareSupported: false })
      })
      refreshRemote(sensenovaStatus, (sensenova) => { patchReady({ sensenova }) })
      refreshRemote(nvidiaStatus, (nvidia) => { patchReady({ nvidia }) })
      // A failed account refresh has no reliable access token for these
      // gateway-backed requests. The durable model catalog is browser-safe,
      // however, so still ask the Host for its offline cache.
      if (!accountResult.ok) {
        refreshRemote(backendCatalog, (managedCatalog) => { patchReady({ managedCatalog: withAgnesModels(managedCatalog) }) }, () => undefined)
        return
      }
      if (account.status !== 'authenticated') {
        // Only the email is remembered; the password must be entered by the
        // user, so no automatic sign-in is attempted on their behalf.
        const saved = account.status === 'signed-out' || account.status === 'reauth-required' ? readRememberedLogin() : undefined
        if (!autoLoginAttempted.current && saved !== undefined) {
          autoLoginAttempted.current = true
          setEmail(previous => previous === '' ? saved.email : previous)
          setRememberLogin(saved.keepSignedIn)
        }
        return
      }
      refreshRemote(backendCatalog, (managedCatalog) => { patchReady({ managedCatalog: withAgnesModels(managedCatalog) }) }, (error) => { patchReady({ actionError: error instanceof Error ? error.message : String(error) }) }, 2)
      refreshRemote(paymentPlans, (plans) => { patchReady({ plans }) }, (error) => { patchReady({ actionError: describePaymentError(error instanceof Error ? error.message : String(error), language) }) }, 5)
      // Read beside the plans because the card form cannot be offered without
      // it: a missing publishable key is the difference between an in-panel
      // Stripe Element and a dialog that has to send the user elsewhere.
      refreshRemote(paymentConfig, (paymentConfigValue) => { patchReady({ paymentConfig: paymentConfigValue }) }, () => undefined, 5)
      refreshRemote(paymentChannels, (channels) => {
        setPaymentType(previous => channels.some(channel => channel.paymentType === previous) ? previous : channels[0]?.paymentType ?? '')
        patchReady({ channels })
      }, (error) => { patchReady({ actionError: describePaymentError(error instanceof Error ? error.message : String(error), language) }) }, 5)
      refreshRemote(paymentOrders, (value) => {
        const pendingOrders = parsePendingOrders(value)
        // An empty result must clear the stale banner: merging an empty patch
        // kept the previous `pendingOrders` forever (cache included), so a
        // paid/cancelled order kept showing "待支付" with a failing cancel
        // button until the cache expired.
        patchReady({ pendingOrders })
      }, () => undefined, 1)
    })().catch((error: unknown) => { offline(error instanceof Error ? error.message : String(error)) })
  }
  const chooseModel = (model: string): void => {
    if (setDefaultModel === undefined) return
    // An empty value means "clear the persisted default", after which the Host
    // resolves the route from config and engine defaults. The picker no longer
    // emits it — the removal of the "backend default" option took the last
    // caller — but the remote still accepts it, so the path is kept whole.
    void setDefaultModel(model).then((result) => {
      if (!result.ok) {
        setState(previous => previous.status === 'ready' ? { ...previous, actionError: result.error.message } : previous)
        return
      }
      setState((previous) => {
        if (previous.status !== 'ready') return previous
        const { actionError: _actionError, ...ready } = previous
        // The cache is what the next open paints while the document read is in
        // flight. Without this write it kept the model the user had *before*
        // this gesture, so a reopen showed the old selection for a moment — and
        // when that read failed, for good.
        const next: ReadyState = { ...ready, catalog: { ...previous.catalog, defaultModel: result.value.model } }
        saveSettingsCache(language, catalog, next)
        return next
      })
    }, (error: unknown) => { setState(previous => previous.status === 'ready' ? { ...previous, actionError: error instanceof Error ? error.message : String(error) } : previous) })
  }
  const chooseMediaModel = (category: Exclude<ModelCategory, 'text'>, model: string, retry = true): Promise<boolean> => {
    if (setDefaultModel === undefined || model === '') return Promise.resolve(false)
    return setDefaultModel(`__freecodego_media_default__:${category}:${model}`).then((result) => {
      if (!result.ok) {
        if (retry) return chooseMediaModel(category, model, false)
        setState(previous => previous.status === 'ready' ? { ...previous, actionError: result.error.message } : previous)
        return false
      }
      setState((previous) => {
        if (previous.status !== 'ready') return previous
        const { actionError: _actionError, ...ready } = previous
        const next: ReadyState = { ...ready, catalog: { ...previous.catalog, mediaDefaults: { ...(previous.catalog.mediaDefaults ?? { image: '', video: '', audio: '' }), [category]: result.value.model } } }
        // Same as the text default: paint the user's own choice on the next
        // open instead of the value this panel happened to sync last.
        saveSettingsCache(language, catalog, next)
        return next
      })
      return true
    }, (error: unknown) => {
      setState(previous => previous.status === 'ready' ? { ...previous, actionError: error instanceof Error ? error.message : String(error) } : previous)
      return false
    })
  }
  const moveModelToCategory = (category: ModelCategory): void => {
    if (state.status !== 'ready' || setModelCategoryDirect === undefined || modelMoveCandidate === '') return
    if (!categoryMoveCandidates.some(item => item.key === modelMoveCandidate)) return
    void setModelCategoryDirect(modelMoveCandidate, category).then(() => {
      const modelCategories = { ...(capabilitySnapshot?.modelCategories ?? {}), [modelMoveCandidate]: category }
      setCapabilitySnapshot(current => current === undefined ? current : { ...current, modelCategories })
      setModelMoveCandidate('')
    }, (error: unknown) => { setState(previous => previous.status === 'ready' ? { ...previous, actionError: error instanceof Error ? error.message : String(error) } : previous) })
  }
  useEffect(() => {
    const reader = readMediaDefaults
    const generation = ++mediaDefaultsReadGeneration.current
    let active = true
    let retry: ReturnType<typeof globalThis.setTimeout> | undefined
    if (reader === undefined) {
      setMediaDefaultsSource('document')
      return () => { active = false }
    }
    // Read once the panel can hold the answer: a result applied to a not-ready
    // state is dropped, and a dropped read used to leave the cached value as
    // the panel's permanent truth without ever re-reading the document.
    if (state.status !== 'ready') return () => { active = false }
    setMediaDefaultsSource('pending')
    const attempt = (remaining: number): void => {
      void reader().then((defaults) => {
        if (!active || generation !== mediaDefaultsReadGeneration.current) return
        setState((previous) => {
          if (previous.status !== 'ready') return previous
          const current = previous.catalog.mediaDefaults
          if (current?.image === defaults.image && current.video === defaults.video && current.audio === defaults.audio) return previous
          const next = { ...previous, catalog: { ...previous.catalog, mediaDefaults: defaults } }
          saveSettingsCache(language, catalog, next)
          return next
        })
        if (active && generation === mediaDefaultsReadGeneration.current) setMediaDefaultsSource('document')
      }, () => {
        if (!active || generation !== mediaDefaultsReadGeneration.current) return
        if (remaining > 0) { retry = globalThis.setTimeout(() => { attempt(remaining - 1) }, MEDIA_DEFAULTS_READ_RETRY_MS); return }
        // Giving up means "unknown", not "empty": the panel keeps showing what
        // it has and adopts nothing, so a read that never landed cannot rewrite
        // a default the document still holds.
        setMediaDefaultsSource('unavailable')
      })
    }
    attempt(MEDIA_DEFAULTS_READ_RETRIES)
    return () => { active = false; if (retry !== undefined) globalThis.clearTimeout(retry) }
  }, [readMediaDefaults, connectionEpoch, language, catalog, state.status])
  useEffect(() => {
    if (state.status !== 'ready' || setDefaultModel === undefined || !capabilitiesLoaded || mediaDefaultsSource !== 'document') return
    // An empty catalog is the state before the Host catalog lands, not evidence
    // that a stored model was retired; deciding from it is how a saved
    // image/video/audio choice got replaced by the first row of the local floor.
    if (effectiveCatalog.models.length === 0) return
    const defaults = state.catalog.mediaDefaults ?? { image: '', video: '', audio: '' }
    const candidate = (model: ManagedCatalog['models'][number]): { readonly id: string; readonly provider: string; readonly displayName: string } => ({ id: model.id, provider: model.provider, displayName: model.displayName })
    for (const category of ['image', 'video', 'audio'] as const) {
      const listed = effectiveCatalog.models.filter(model => modelCategoryOf(model, capabilitySnapshot?.modelCategories) === category)
      const available = listed.filter(model => model.availability === 'available').map(candidate)
      if (mediaDefaultsInitialized.current.has(category) || mediaDefaultsPending.current.has(category)) continue
      const retryAt = mediaDefaultRetryAfter.get(category)
      if (retryAt !== undefined) {
        if (Date.now() < retryAt) continue
        mediaDefaultRetryAfter.delete(category)
      }
      // One decision covers all three states of a stored default: still valid,
      // migrated across a provider-prefix change, or retired. The previous
      // inline branch handled only the first two, so a model withdrawn from the
      // live directory stayed in the settings document forever and every
      // generation kept failing against a route that no longer existed. A model
      // that is merely unusable *right now* keeps its value — see
      // `decideMediaDefault`.
      // The stored value is compared without its group pin: a row the user
      // picked from a named group persists as `id@group:N` while the catalog
      // lists the bare id, and reading that as "not listed" replaced a choice
      // the user made from a group with an automatic pick from another one.
      const decision = decideMediaDefault(displayModelSelection(defaults[category]), available, listed.map(candidate))
      if (decision.action === 'keep') {
        mediaDefaultsInitialized.current.add(category)
        continue
      }
      if (decision.action === 'unset') continue
      // Marking before the call keeps a failed persistence attempt from being
      // re-issued on the rerenders the error state itself triggers; the retry
      // map alone gates the next automatic attempt.
      mediaDefaultsInitialized.current.add(category)
      mediaDefaultsPending.current.add(category)
      void chooseMediaModel(category, decision.next).then((saved) => {
        if (saved) mediaDefaultRetryAfter.delete(category)
        else mediaDefaultRetryAfter.set(category, Date.now() + MEDIA_DEFAULT_RETRY_AFTER_MS)
      }, () => { mediaDefaultRetryAfter.set(category, Date.now() + MEDIA_DEFAULT_RETRY_AFTER_MS) }).finally(() => { mediaDefaultsPending.current.delete(category) })
    }
  }, [state, nativeModels, effectiveCatalog, capabilitiesLoaded, mediaDefaultsSource, capabilitySnapshot?.modelCategories, setDefaultModel])
  const chooseEngine = (engine: 'deepseek' | 'codex' | 'claude'): void => {
    if (setDefaultEngine === undefined || state.status !== 'ready') return
    void setDefaultEngine(engine).then((result) => {
      if (!result.ok) {  setState(previous => previous.status === 'ready' ? { ...previous, actionError: result.error.message } : previous); return }
      setState(previous => previous.status === 'ready' ? { ...previous, catalog: { ...previous.catalog, defaultEngine: result.value.engine } } : previous)
    }, (error: unknown) => { setState(previous => previous.status === 'ready' ? { ...previous, actionError: error instanceof Error ? error.message : String(error) } : previous) })
  }
  const toggleAdvisor = (enabled: boolean): void => {
    if (advisorUpdate === undefined || advisorToggleBusy) return
    setAdvisorToggleBusy(true)
    void advisorUpdate({ advisorEnabled: enabled }).then((result) => {
      if (result.ok) { setAdvisorSnapshot(result.value); publishAdvisorSnapshot(result.value) }
      else setState(previous => previous.status === 'ready' ? { ...previous, actionError: result.error.message } : previous)
    }, (error: unknown) => { setState(previous => previous.status === 'ready' ? { ...previous, actionError: error instanceof Error ? error.message : String(error) } : previous) }).finally(() => { setAdvisorToggleBusy(false) })
  }
  const toggleEngineering = (enabled: boolean): void => {
    if (engineeringSetEnabled === undefined || engineeringToggleBusy) return
    setEngineeringToggleBusy(true)
    void engineeringSetEnabled(enabled).then((result) => {
      if (result.ok) { setEngineeringSnapshot(result.value); publishEngineeringSnapshot(result.value) }
      else setState(previous => previous.status === 'ready' ? { ...previous, actionError: result.error.message } : previous)
    }, (error: unknown) => { setState(previous => previous.status === 'ready' ? { ...previous, actionError: error instanceof Error ? error.message : String(error) } : previous) }).finally(() => { setEngineeringToggleBusy(false) })
  }
  const applyLogfareStatus = (logfare: FreeCodeGoLogfareStatus): void => {
    setState((previous) => {
      if (previous.status !== 'ready') return previous
      const next = { ...previous, logfare }
      saveSettingsCache(language, catalog, next)
      return next
    })
  }
  const refreshManagedMediaCatalog = (): void => {
    if (backendCatalog === undefined) return
    void backendCatalog().then((result) => {
      if (!result.ok) return
      setState(previous => previous.status === 'ready' ? { ...previous, managedCatalog: withAgnesModels(result.value) } : previous)
    }, () => undefined)
  }
  const saveVyceKey = (): void => {
    if (vyceSetKey === undefined || vyceBusy) return
    setVyceBusy(true)
    void vyceSetKey(vyceKey).then((result) => {
      if (!result.ok) setState(previous => previous.status === 'ready' ? { ...previous, actionError: result.error.message } : previous)
      else { setVyceKey(''); setState(previous => previous.status === 'ready' ? { ...previous, vyce: result.value } : previous) }
    }, (error: unknown) => { setState(previous => previous.status === 'ready' ? { ...previous, actionError: error instanceof Error ? error.message : String(error) } : previous) }).finally(() => { setVyceBusy(false) })
  }
  const clearVyceKey = (): void => {
    if (vyceSetKey === undefined || vyceBusy) return
    setVyceBusy(true)
    void vyceSetKey('').then((result) => {
      if (!result.ok) setState(previous => previous.status === 'ready' ? { ...previous, actionError: result.error.message } : previous)
      else setState(previous => previous.status === 'ready' ? { ...previous, vyce: result.value } : previous)
    }, (error: unknown) => { setState(previous => previous.status === 'ready' ? { ...previous, actionError: error instanceof Error ? error.message : String(error) } : previous) }).finally(() => { setVyceBusy(false) })
  }
  const registerLogfare = (): void => {
    if (logfareRegister === undefined || logfareRegisterBusy || state.status !== 'ready') return
    // Logfare requires these fields for account creation. The compact flow
    // accepts them by default and keeps its one-time credentials internal.
    const credentials = createLogfareCredentials()
    setLogfareRegisterBusy(true)
    void logfareRegister({ ...credentials, ageConfirmed: true, tosAccepted: true, trainingOptIn: false }).then((result) => {
      if (!result.ok) {
        setState(previous => previous.status === 'ready' ? { ...previous, actionError: result.error.message } : previous)
        return
      }
      applyLogfareStatus(result.value)
      refreshManagedMediaCatalog()
    }, (error: unknown) => { setState(previous => previous.status === 'ready' ? { ...previous, actionError: error instanceof Error ? error.message : String(error) } : previous) }).finally(() => { setLogfareRegisterBusy(false) })
  }
  /**
   * Store a Logfare key the user already holds.
   *
   * Applying for a credential and supplying an existing one were the same single
   * path before this: `logfareRegister` creates an account and saves whatever the
   * backend issues. Someone with a key from another machine had no way to enter
   * it, so the only route was to apply again under a new identity.
   */
  const saveLogfareKey = (): void => {
    if (logfareSetKey === undefined || logfareKeyBusy || logfareKey.trim() === '') return
    setLogfareKeyBusy(true)
    void logfareSetKey(logfareKey.trim()).then((result) => {
      if (!result.ok) setState(previous => previous.status === 'ready' ? { ...previous, actionError: result.error.message } : previous)
      else { setLogfareKey(''); applyLogfareStatus(result.value); refreshManagedMediaCatalog() }
    }, (error: unknown) => { setState(previous => previous.status === 'ready' ? { ...previous, actionError: error instanceof Error ? error.message : String(error) } : previous) }).finally(() => { setLogfareKeyBusy(false) })
  }
  /**
   * Add one Cline account from a refresh token the user already has.
   *
   * Device sign-in adds accounts one browser round-trip at a time and cannot
   * import a session that lives elsewhere ({@link ClineStatus} already supports
   * several accounts, so the pool was reachable only by signing in again on this
   * machine).
   */
  const addClineAccount = (): void => {
    if (clineAddAccount === undefined || clineBusy || clineToken.trim() === '') return
    setClineBusy(true)
    void clineAddAccount(clineToken.trim()).then((result) => {
      if (!result.ok) { setState(failed(describeClineError(result.error.message))); return }
      setClineToken('')
      load(true)
    }, (error: unknown) => { setState(failed(describeClineError(error instanceof Error ? error.message : String(error)))) }).finally(() => { setClineBusy(false) })
  }
  const setLogfareTraining = (): void => {
    if (logfareSetTrainingOptIn === undefined || logfareTrainingBusy) return
    setLogfareTrainingBusy(true)
    void logfareSetTrainingOptIn(true).then((result) => {
      if (!result.ok) setState(previous => previous.status === 'ready' ? { ...previous, actionError: result.error.message } : previous)
      else { applyLogfareStatus(result.value); refreshManagedMediaCatalog() }
    }, (error: unknown) => { setState(previous => previous.status === 'ready' ? { ...previous, actionError: error instanceof Error ? error.message : String(error) } : previous) }).finally(() => { setLogfareTrainingBusy(false) })
  }
  const saveSensenovaKey = (): void => {
    if (sensenovaSetKey === undefined || sensenovaBusy) return
    setSensenovaBusy(true)
    void sensenovaSetKey(sensenovaKey).then((result) => {
      if (!result.ok) {
        setState(previous => previous.status === 'ready' ? { ...previous, actionError: result.error.message } : previous)
        return
      }
      setSensenovaKey('')
      setState(previous => previous.status === 'ready' ? { ...previous, sensenova: result.value } : previous)
    }, (error: unknown) => { setState(previous => previous.status === 'ready' ? { ...previous, actionError: error instanceof Error ? error.message : String(error) } : previous) }).finally(() => { setSensenovaBusy(false) })
  }
  const clearSensenovaKey = (): void => {
    if (sensenovaSetKey === undefined || sensenovaBusy) return
    setSensenovaBusy(true)
    void sensenovaSetKey('').then((result) => {
      if (!result.ok) setState(previous => previous.status === 'ready' ? { ...previous, actionError: result.error.message } : previous)
      else setState(previous => previous.status === 'ready' ? { ...previous, sensenova: result.value } : previous)
    }, (error: unknown) => { setState(previous => previous.status === 'ready' ? { ...previous, actionError: error instanceof Error ? error.message : String(error) } : previous) }).finally(() => { setSensenovaBusy(false) })
  }
  const saveNvidiaKey = (): void => {
    if (nvidiaSetKey === undefined || nvidiaBusy) return
    setNvidiaBusy(true)
    void nvidiaSetKey(nvidiaKey).then((result) => {
      if (!result.ok) {
        setState(previous => previous.status === 'ready' ? { ...previous, actionError: result.error.message } : previous)
        return
      }
      setNvidiaKey('')
      setState(previous => previous.status === 'ready' ? { ...previous, nvidia: result.value } : previous)
    }, (error: unknown) => { setState(previous => previous.status === 'ready' ? { ...previous, actionError: error instanceof Error ? error.message : String(error) } : previous) }).finally(() => { setNvidiaBusy(false) })
  }
  const clearNvidiaKey = (): void => {
    if (nvidiaSetKey === undefined || nvidiaBusy) return
    setNvidiaBusy(true)
    void nvidiaSetKey('').then((result) => {
      if (!result.ok) setState(previous => previous.status === 'ready' ? { ...previous, actionError: result.error.message } : previous)
      else setState(previous => previous.status === 'ready' ? { ...previous, nvidia: result.value } : previous)
    }, (error: unknown) => { setState(previous => previous.status === 'ready' ? { ...previous, actionError: error instanceof Error ? error.message : String(error) } : previous) }).finally(() => { setNvidiaBusy(false) })
  }
  useEffect(() => {
    const reconnected = observedConnectionEpoch.current !== connectionEpoch
    observedConnectionEpoch.current = connectionEpoch
    load(reconnected, reconnected)
  }, [catalog, connectionEpoch, language])
  useEffect(() => {
    if (capabilities === undefined) {
      setCapabilitiesLoaded(true)
      return
    }
    let active = true
    setCapabilitiesLoaded(false)
    void capabilities().then((result) => {
      if (!active) return
      if (result.ok) {
        setCapabilitySnapshot(result.value)
        if (readLocalCapabilities !== undefined) void readLocalCapabilities().then((local) => {
          if (active) setCapabilitySnapshot(current => current === undefined ? current : { ...current, ...local })
        }, () => undefined)
      }
      else setState(previous => previous.status === 'ready' ? { ...previous, actionError: result.error.message } : previous)
    }, (error: unknown) => {
      if (active) setState(previous => previous.status === 'ready' ? { ...previous, actionError: error instanceof Error ? error.message : String(error) } : previous)
    }).finally(() => { if (active) setCapabilitiesLoaded(true) })
    return () => { active = false }
  }, [capabilities, readLocalCapabilities, connectionEpoch])
  useEffect(() => {
    // Read the picker's own directory first: it is the list these controls
    // filter, and it exists whenever a session is bound.
    if (pickerModelDirectory !== undefined) {
      try { setPickerRows(pickerModelDirectory()) } catch { setPickerRows([]) }
    }
    if (nativeModelCatalog === undefined) return
    let active = true
    try {
      void nativeModelCatalog().then((result) => {
        if (active && result.ok) setNativeModels(flattenNativeModelCatalog(result.value))
      }, () => undefined)
    } catch {
      // The category editor is additive. An older session remote must not
      // make the entire FreeCodeGo settings page fail to render.
    }
    return () => { active = false }
  }, [nativeModelCatalog, pickerModelDirectory, connectionEpoch, nativeModelSessionId, nativeCatalogEpoch])
  useEffect(() => {
    if (pluginUpdateStatus === undefined) return
    let active = true
    void pluginUpdateStatus().then((result) => { if (active && result.ok) setPluginUpdateSnapshot(result.value) }, ignoreRejection)
    return () => { active = false }
  }, [pluginUpdateStatus, connectionEpoch])
  useEffect(() => {
    if (codexRuntimeStatus === undefined) return
    let active = true
    void codexRuntimeStatus().then((result) => { if (active && result.ok) setCodexStatus(result.value) }, ignoreRejection)
    return () => { active = false }
  }, [codexRuntimeStatus, connectionEpoch])
  useEffect(() => {
    if (claudeRuntimeStatus === undefined) return
    let active = true
    void claudeRuntimeStatus().then((result) => { if (active && result.ok) setClaudeStatus(result.value) }, ignoreRejection)
    return () => { active = false }
  }, [claudeRuntimeStatus, connectionEpoch])
  const openRuntimePicker = (engine: 'codex' | 'claude'): void => {
    setRuntimePicker(engine)
    const loadPackages = engine === 'codex' ? codexRuntimePackages : claudeRuntimePackages
    if (loadPackages === undefined) return
    void loadPackages().then((result) => {
      if (result.ok) {
        if (engine === 'codex') setCodexPackages(result.value)
        else setClaudePackages(result.value)
      } else setState(previous => previous.status === 'ready' ? { ...previous, actionError: result.error.message } : previous)
    }, (error: unknown) => { setState(previous => previous.status === 'ready' ? { ...previous, actionError: error instanceof Error ? error.message : String(error) } : previous) })
  }
  const installCodex = (packageID?: string): void => {
    if (codexRuntimeInstall === undefined || codexBusy) return
    setRuntimePicker(undefined)
    setCodexBusy(true)
    void codexRuntimeInstall(packageID).then((result) => {
      if (!result.ok) { setState(previous => previous.status === 'ready' ? { ...previous, actionError: result.error.message } : previous); return }
      setCodexStatus(result.value)
      // The engine dropdown reads `state.catalog.engines`, which only refreshes
      // on an explicit load. Without this, the just-installed engine stays
      // disabled until the user happens to click "刷新引擎状态".
      void catalog().then((engineResult) => {
        if (engineResult.ok) setState(previous => previous.status === 'ready' ? { ...previous, catalog: engineResult.value } : previous)
      }, () => undefined)
    }, (error: unknown) => { setState(previous => previous.status === 'ready' ? { ...previous, actionError: error instanceof Error ? error.message : String(error) } : previous) }).finally(() => { setCodexBusy(false) })
  }
  const removeCodex = (): void => {
    if (codexRuntimeRemove === undefined || codexBusy) return
    setCodexBusy(true)
    void codexRuntimeRemove().then((result) => {
      if (!result.ok) { setState(previous => previous.status === 'ready' ? { ...previous, actionError: result.error.message } : previous); return }
      setCodexStatus(result.value)
      void catalog().then((engineResult) => {
        if (engineResult.ok) setState(previous => previous.status === 'ready' ? { ...previous, catalog: engineResult.value } : previous)
      }, () => undefined)
    }, (error: unknown) => { setState(previous => previous.status === 'ready' ? { ...previous, actionError: error instanceof Error ? error.message : String(error) } : previous) }).finally(() => { setCodexBusy(false) })
  }
  const installClaude = (packageID?: string): void => {
    if (claudeRuntimeInstall === undefined || claudeBusy) return
    setRuntimePicker(undefined)
    setClaudeBusy(true)
    void claudeRuntimeInstall(packageID).then((result) => {
      if (!result.ok) { setState(previous => previous.status === 'ready' ? { ...previous, actionError: result.error.message } : previous); return }
      setClaudeStatus(result.value)
      void catalog().then((engineResult) => {
        if (engineResult.ok) setState(previous => previous.status === 'ready' ? { ...previous, catalog: engineResult.value } : previous)
      }, () => undefined)
    }, (error: unknown) => { setState(previous => previous.status === 'ready' ? { ...previous, actionError: error instanceof Error ? error.message : String(error) } : previous) }).finally(() => { setClaudeBusy(false) })
  }
  const removeClaude = (): void => {
    if (claudeRuntimeRemove === undefined || claudeBusy) return
    setClaudeBusy(true)
    void claudeRuntimeRemove().then((result) => {
      if (!result.ok) { setState(previous => previous.status === 'ready' ? { ...previous, actionError: result.error.message } : previous); return }
      setClaudeStatus(result.value)
      void catalog().then((engineResult) => {
        if (engineResult.ok) setState(previous => previous.status === 'ready' ? { ...previous, catalog: engineResult.value } : previous)
      }, () => undefined)
    }, (error: unknown) => { setState(previous => previous.status === 'ready' ? { ...previous, actionError: error instanceof Error ? error.message : String(error) } : previous) }).finally(() => { setClaudeBusy(false) })
  }
  const submitLogin = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (authBusy !== undefined) return
    setAuthNotice(undefined)
    setAuthBusy('login')
    void login(email, password, rememberLogin, rememberPassword).then((result) => {
      if (!result.ok) {
        // A rejected credential may have changed, but a transient server
        // error must not erase the remembered email; the network-failure
        // path below keeps it too. Only explicit sign-out clears it (2061).
        setAuthNotice(describeAccountError(result.error.message, language)); return
      }
      try {
        // Browser storage keeps the address and the session intent, never the
        // password: the ticked box is what asks the Host to keep that, and this
        // very call is where the credential file was written or erased.
        if (rememberLogin) globalThis.localStorage?.setItem('freecodego.login.remember', JSON.stringify({ email, keepSignedIn: true }))
        else globalThis.localStorage?.setItem('freecodego.login.remember', JSON.stringify({ email, keepSignedIn: false }))
      } catch (error) {
        setAuthNotice(describeAccountError(error instanceof Error ? error.message : String(error), language)); return
      }
      setPassword('')
      load(true)
    }, (error: unknown) => { setAuthNotice(describeAccountError(error instanceof Error ? error.message : String(error), language)) }).finally(() => { setAuthBusy(undefined) })
  }
  const submitRegister = (): void => {
    if (register === undefined || authBusy !== undefined) return
    setAuthNotice(undefined)
    setAuthBusy('register')
    void register({ email, password, ...(verifyCode === '' ? {} : { verifyCode }) }).then((result) => {
      if (!result.ok) { setAuthNotice(describeAccountError(result.error.message, language)); return }
      setPassword('')
      load(true)
    }, (error: unknown) => { setAuthNotice(describeAccountError(error instanceof Error ? error.message : String(error), language)) }).finally(() => { setAuthBusy(undefined) })
  }
  /** Registration and MFA live in their own forms now, so both need an
   * explicit submit handler — Enter inside those fields used to submit the
   * login form they were nested in. */
  const submitRegistration = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    submitRegister()
  }
  const submitMfaCode = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    submitMfa()
  }
  /** Send the registration code with the Host-reported countdown, so the
   * resend button cannot be hammered into the upstream rate limit. */
  const sendAccountVerifyCode = (): void => {
    if (sendVerifyCode === undefined || verifySending || verifyCooldown > 0) return
    setAuthNotice(undefined)
    setVerifySending(true)
    void sendVerifyCode(email).then((result) => {
      if (!result.ok) {
        setAuthNotice(describeAccountError(result.error.message, language))
        if (/too frequent|rate.?limit/i.test(result.error.message)) setVerifyCooldown(60)
        return
      }
      setVerifyCooldown(result.value.countdown > 0 ? result.value.countdown : 60)
    }, (error: unknown) => { setAuthNotice(describeAccountError(error instanceof Error ? error.message : String(error), language)) }).finally(() => { setVerifySending(false) })
  }
  /**
   * Ask the gateway to mail the password-reset code.
   *
   * This is the code channel an *existing* account has: the registration one
   * refuses a registered address outright, which is what left a returning user
   * with no way forward from the 注册 tab.
   */
  const sendResetCode = (): void => {
    if (forgotPassword === undefined || resetSending || resetCooldown > 0) return
    const target = email.trim()
    if (target === '') { setAuthNotice(language === 'zh' ? '请先填写邮箱，再获取重置验证码。' : 'Enter the address first, then request the reset code.'); return }
    setAuthNotice(undefined)
    setResetSending(true)
    void forgotPassword(target).then((result) => {
      if (!result.ok) {
        setAuthNotice(describeAccountError(result.error.message, language))
        if (/too frequent|rate.?limit/i.test(result.error.message)) setResetCooldown(60)
        return
      }
      // The gateway answers identically for an unknown address, by design, so the
      // card states that instead of implying the mailbox was found.
      setResetCooldown(60)
      setAuthNotice(language === 'zh'
        ? '若该邮箱已注册，重置验证码已发送；请查收邮件后填写验证码与新密码。'
        : 'If that address has an account, a reset code is on its way — enter the code and a new password below.')
    }, (error: unknown) => { setAuthNotice(describeAccountError(error instanceof Error ? error.message : String(error), language)) }).finally(() => { setResetSending(false) })
  }
  /**
   * Replace the password, then hand the user back to the sign-in form.
   *
   * The reset is deliberately not a sign-in: the gateway issues no session for
   * it, so promising one would leave the card showing an account the Host does
   * not have. The new password is cleared from state the moment the gateway
   * accepts it, and the login form keeps the address.
   */
  const submitResetPassword = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (resetPassword === undefined || resetBusy) return
    const target = email.trim()
    const code = resetCode.trim()
    if (target === '') { setAuthNotice(language === 'zh' ? '请先填写邮箱。' : 'Enter the email address first.'); return }
    if (code === '') { setAuthNotice(language === 'zh' ? '请填写邮件里的重置验证码。' : 'Enter the reset code from the email.'); return }
    setAuthNotice(undefined)
    setResetBusy(true)
    void resetPassword({ email: target, verifyCode: code, newPassword: resetSecret }).then((result) => {
      if (!result.ok) { setAuthNotice(describeAccountError(result.error.message, language)); return }
      setResetSecret('')
      setResetCode('')
      setPassword('')
      setResetOpen(false)
      setAuthTab('login')
      setAuthNotice(language === 'zh' ? '密码已重置，请用新密码登录。' : 'Password reset. Sign in with the new password.')
    }, (error: unknown) => { setAuthNotice(describeAccountError(error instanceof Error ? error.message : String(error), language)) }).finally(() => { setResetBusy(false) })
  }
  /**
   * Federated sign-in. One code path serves both the placeholder and the real
   * interface: until the Host exposes its OAuth endpoints it rejects with
   * `OAUTH_NOT_WIRED`, which is explained in place rather than looking like a
   * failed credential check.
   */
  const submitOAuth = (provider: FreeCodeGoOAuthProvider): void => {
    if (oauthLogin === undefined || oauthBusy !== undefined) return
    const label = provider === 'google' ? 'Google' : 'GitHub'
    setOauthBusy(provider)
    setOauthNotice(undefined)
    const absorbPending = (detail: string): boolean => {
      const registration = parseOAuthRegistrationRequired(detail)
      if (registration === undefined) return false
      setOauthPending(registration)
      setOauthPendingMode(registration.step === 'bind-login' ? 'bind' : 'create')
      setOauthPendingEmail(registration.email ?? '')
      setOauthPendingPassword('')
      setOauthPendingTotpCode('')
      setOauthPendingVerifyCode('')
      setOauthPendingInvitation('')
      setOauthNotice(undefined)
      return true
    }
    void oauthLogin(provider).then((result) => {
      if (!result.ok) {
        if (absorbPending(result.error.message)) return
        if (/OAUTH_NOT_WIRED/i.test(result.error.message)) {
          setOauthNotice(language === 'zh' ? `${label} 登录尚未接入，Host 接口就绪后会自动启用。` : `${label} sign-in is not wired up yet; it turns on as soon as the Host exposes the endpoint.`)
          return
        }
        setState(failed(result.error.message))
        return
      }
      load(true)
    }, (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error)
      if (absorbPending(detail)) return
      if (/OAUTH_NOT_WIRED/i.test(detail)) {
        setOauthNotice(language === 'zh' ? `${label} 登录尚未接入，Host 接口就绪后会自动启用。` : `${label} sign-in is not wired up yet; it turns on as soon as the Host exposes the endpoint.`)
        return
      }
      setState(failed(detail))
    }).finally(() => { setOauthBusy(undefined) })
  }
  const submitOAuthPendingVerifyCode = (): void => {
    if (oauthPendingSendVerifyCode === undefined || oauthPendingBusy || oauthPendingVerifyCooldown > 0) return
    const target = oauthPendingEmail.trim()
    if (target === '') return
    setOauthPendingBusy(true)
    void oauthPendingSendVerifyCode(target).then((result) => {
      if (!result.ok) {  setState(failed(result.error.message)); return }
      setOauthPendingVerifyCooldown(result.value.countdown > 0 ? result.value.countdown : 60)
    }, (error: unknown) => { setState(failed(error instanceof Error ? error.message : String(error))) }).finally(() => { setOauthPendingBusy(false) })
  }
  const submitOAuthPending = (): void => {
    if (oauthPendingBusy) return
    const target = oauthPendingEmail.trim()
    const secret = oauthPendingPassword
    if (target === '' || secret === '') return
    if (oauthPendingMode === 'bind') {
      if (oauthPendingBind === undefined) return
      setOauthPendingBusy(true)
      const totpCode = oauthPendingTotpCode.trim()
      void oauthPendingBind({ email: target, password: secret, ...(totpCode === '' ? {} : { totpCode }) }).then((result) => {
        if (!result.ok) {  setState(failed(result.error.message)); return }
        setOauthPending(undefined)
        setOauthPendingPassword('')
        setOauthPendingTotpCode('')
        load(true)
      }, (error: unknown) => { setState(failed(error instanceof Error ? error.message : String(error))) }).finally(() => { setOauthPendingBusy(false) })
      return
    }
    if (oauthPendingCreate === undefined) return
    const verify = oauthPendingVerifyCode.trim()
    const invitation = oauthPendingInvitation.trim()
    if (verify === '' || (oauthPending?.invitationRequired === true && invitation === '')) return
    setOauthPendingBusy(true)
    void oauthPendingCreate({ email: target, password: secret, verifyCode: verify, ...(invitation === '' ? {} : { invitationCode: invitation }) }).then((result) => {
      if (!result.ok) {
        // A collision flips the session back to the chooser; offer binding instead.
        const registration = parseOAuthRegistrationRequired(result.error.message)
        if (registration !== undefined) {
          setOauthPendingMode('bind')
          setOauthNotice(language === 'zh' ? '该邮箱已有账号，请输入原账号密码完成绑定。' : 'That email already has an account; enter its password to bind.')
          return
        }
        setState(failed(result.error.message)); return
      }
      setOauthPending(undefined)
      setOauthPendingPassword('')
      load(true)
    }, (error: unknown) => { setState(failed(error instanceof Error ? error.message : String(error))) }).finally(() => { setOauthPendingBusy(false) })
  }
  const submitMfa = (): void => {
    if (completeMfa === undefined || totpCode === '') return
    void completeMfa(totpCode).then((result) => {
      if (!result.ok) {
        // The Host validates the MFA ticket before grading the code. Once the
        // challenge is dead (signed-out, expired temp token, 401/403/422) the
        // TOTP input would never succeed again; re-read the authoritative
        // account state so the UI falls back to the login form.
        const staleChallenge = /401|403|422|temp[\s_-]*token|expired|invalid[\s_-]*state|unauthori[sz]ed/i.test(result.error.message)
          || state.status !== 'ready' || state.account.status !== 'mfa-required'
        if (staleChallenge) { load(true); return }
        setState(failed(result.error.message)); return
      }
      setTotpCode('')
      setState(previous => previous.status === 'ready' ? { ...previous, account: result.value } : previous)
      if (result.value.status === 'authenticated') load(true)
    }, (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error)
      if (/401|403|422|temp[\s_-]*token|expired|unauthori[sz]ed/i.test(detail) || state.status !== 'ready' || state.account.status !== 'mfa-required') { load(true); return }
      setState(failed(detail))
    })
  }
  const startCheckout = (plan: PaymentPlan): void => {
    if (checkoutLock.current || checkoutPending || paymentCheckout === undefined || plan.price === undefined || !Number.isFinite(plan.price) || plan.price <= 0 || selectedPaymentType === '') return
    const channel = state.status === 'ready' ? state.channels.find(item => item.paymentType === selectedPaymentType) : undefined
    // Checkout failures are reported *here*, next to the button that was pressed,
    // and not through the panel-wide `actionError`: that one renders at the top of
    // the tab, so on a tall payment section a rejected order looked exactly like a
    // button that does nothing — which is how a real validation bug stayed hidden.
    setCheckoutError(undefined)
    let paymentAmount: number
    try { paymentAmount = paymentAmountForCredit(plan.price, channel) } catch (error) {
      setCheckoutError(describePaymentError(error instanceof Error ? error.message : String(error), language))
      return
    }
    checkoutLock.current = true
    setCheckoutPending(true)
    // FreeCodeGo only accepts its canonical payment result route as the
    // callback target, and that route lives under the console mount. The bare
    // `freecodego.com/payment/result` is served by the marketing site (its
    // catch-all returns 200 with the landing page), so paying users landed on
    // the product page instead of the result; the backend's suffix check
    // (`/payment/result`) accepts this console-qualified path unchanged.
    const returnUrl = `${FREECODEGO_WEB_BASE_URL}/payment/result`
    // The FreeCodeGo ladder represents permanent balance credits, not the
    // backend's optional subscription rows. A zero plan id selects the normal
    // balance-order path while `amount` carries the selected credit amount.
    void paymentCheckout(0, selectedPaymentType, returnUrl, paymentAmount).then((result) => {
      if (!result.ok) {
        setCheckoutError(describePaymentError(result.error.message, language))
        // Both failures leave the account holding an order the click cannot
        // show: a rejected order because of the pending-order limit, and a
        // timed-out one because the reply that carried the order id never
        // arrived. Reading the pending list is what makes the error actionable —
        // the panel can then offer to pay or cancel the order that exists.
        if (paymentOrders !== undefined && (/429|too_many_pending|TOO_MANY_PENDING/i.test(result.error.message) || CLIENT_ABORT_PATTERN.test(result.error.message))) {
          void paymentOrders().then((ordersResult) => {
            const pendingOrders = ordersResult.ok ? parsePendingOrders(ordersResult.value) : []
            setState(previous => previous.status === 'ready' ? { ...previous, pendingOrders } : previous)
          }, () => undefined)
        }
        return
      }
      // Hand the order to the in-panel dialog. The payment surfaces live here
      // now: the backend's own checkout page is `frame-ancestors 'none'` (it can
      // never be embedded) and is the console mount, which is not a page to send
      // a customer to. The dialog picks the surface from what the order carries
      // — Stripe Payment Element, QR, or the provider's page as a last resort.
      // Nothing is opened blindly: an order with none of the three says so in
      // place, next to the button that was pressed.
      setPaymentDialog({
        order: result.value,
        channel,
        publishableKey: state.status === 'ready' ? state.paymentConfig?.stripePublishableKey : undefined,
        receiptEmail: state.status === 'ready' ? state.account.user?.email : undefined,
        payCurrency: orderSettlementCurrency(result.value, state.status === 'ready' ? state.channels : []),
      })
      setState(previous => previous.status === 'ready' ? { ...previous, order: result.value } : previous)
    }, (error: unknown) => {
      setCheckoutError(describePaymentError(error instanceof Error ? error.message : String(error), language))
    }).finally(() => {
      checkoutLock.current = false
      setCheckoutPending(false)
    })
  }
  // The ladder and its shared bullets are computed once, from the tiers this panel
  // actually offers: an intersection taken per card would have to be recomputed
  // six times and could disagree with itself.
  const saleablePlans = state.status === 'ready' ? state.plans.filter(plan => plan.forSale !== false) : []
  const planNotes = splitPlanNotes(saleablePlans, language)
  const cancelPendingOrder = (order: PaymentOrder): void => {
    if (paymentCancel === undefined || !canCancelPaymentOrder(order)) return
    void paymentCancel(order.orderId).then((result) => {
      if (!result.ok) {  setState(previous => previous.status === 'ready' ? { ...previous, actionError: describePaymentError(result.error.message, language) } : previous); return }
      setState((previous) => {
        if (previous.status !== 'ready') return previous
        const { actionError: _actionError, pendingOrders, ...rest } = previous
        const remaining = pendingOrders?.filter(item => item.orderId !== order.orderId)
        const currentOrder = rest.order?.orderId === order.orderId ? { ...rest.order, state: 'cancelled' } : rest.order
        const next = currentOrder === undefined ? rest : { ...rest, order: currentOrder }
        return remaining === undefined || remaining.length === 0 ? next : { ...next, pendingOrders: remaining }
      })
    }, (error: unknown) => { setState(previous => previous.status === 'ready' ? { ...previous, actionError: describePaymentError(error instanceof Error ? error.message : String(error), language) } : previous) })
  }
  const refreshOrder = (): void => {
    if (paymentOrder === undefined || state.status !== 'ready' || state.order === undefined) return
    void paymentOrder(state.order.orderId).then((result) => {
      if (!result.ok) {  setState(failed(describePaymentError(result.error.message, language))); return }
      setState(previous => previous.status === 'ready' ? { ...previous, order: result.value } : previous)
    }, (error: unknown) => { setState(failed(describePaymentError(error instanceof Error ? error.message : String(error), language))) })
  }
  /** Re-read one order for the payment dialog's poll; `undefined` means the read failed. */
  const loadDialogOrder = (orderId: string): Promise<PaymentDialogOrder | undefined> => {
    if (paymentOrder === undefined) return Promise.resolve(undefined)
    return paymentOrder(orderId).then(result => result.ok ? result.value : undefined, () => undefined)
  }
  /**
   * A paid order moves the account balance, so the whole panel is re-read —
   * silently, because the dialog is on screen and a loading state behind it
   * would flicker a panel nobody asked to see.
   */
  const settleDialogPayment = (): void => { load(true, true) }
  const cancelDialogOrder = (): void => {
    const order = paymentDialog?.order
    if (order === undefined || paymentCancel === undefined) return
    void paymentCancel(order.orderId).then((result) => {
      if (!result.ok) { setCheckoutError(describePaymentError(result.error.message, language)); return }
      setPaymentDialog(previous => previous === undefined ? previous : { ...previous, order: { ...previous.order, state: 'cancelled' } })
      setState((previous) => {
        if (previous.status !== 'ready') return previous
        const pendingOrders = previous.pendingOrders?.filter(item => item.orderId !== order.orderId)
        return {
          ...previous,
          ...(pendingOrders === undefined ? {} : { pendingOrders }),
          ...(previous.order === undefined ? {} : { order: { ...previous.order, state: 'cancelled' } }),
        }
      })
    }, (error: unknown) => { setCheckoutError(describePaymentError(error instanceof Error ? error.message : String(error), language)) })
  }
  const verifyOrder = (): void => {
    if (paymentVerify === undefined || state.status !== 'ready' || state.order?.outTradeNo === undefined) return
    void paymentVerify(state.order.outTradeNo).then((result) => { if (!result.ok) setState(failed(describePaymentError(result.error.message, language))); else setState(previous => previous.status === 'ready' ? { ...previous, order: result.value } : previous) }, (error: unknown) => { setState(failed(describePaymentError(error instanceof Error ? error.message : String(error), language))) })
  }
  const cancelOrder = (): void => {
    if (paymentCancel === undefined || state.status !== 'ready' || state.order === undefined || !canCancelPaymentOrder(state.order)) return
    void paymentCancel(state.order.orderId).then((result) => { if (!result.ok) setState(failed(describePaymentError(result.error.message, language))); else setState(previous => previous.status === 'ready' && previous.order !== undefined ? { ...previous, order: { ...previous.order, state: 'cancelled' } } : previous) }, (error: unknown) => { setState(failed(describePaymentError(error instanceof Error ? error.message : String(error), language))) })
  }
  const emailReceipt = (): void => {
    if (paymentReceiptEmail === undefined || state.status !== 'ready' || state.order === undefined) return
    void paymentReceiptEmail(state.order.orderId).then((result) => {
      if (!result.ok) {  setState(failed(describePaymentError(result.error.message, language))); return }
    }, (error: unknown) => { setState(failed(describePaymentError(error instanceof Error ? error.message : String(error), language))) })
  }
  /**
   * Save an order's receipt without waiting on email delivery.
   *
   * This is the path that answers "I paid, where is my document?" — the receipt
   * is fetched and saved on the spot, which is also the one that works when the
   * mail service is not configured at all (the email action reports that as its
   * own failure).
   */
  const downloadReceipt = (orderId: string): void => {
    if (paymentReceiptDocument === undefined) return
    void paymentReceiptDocument(orderId).then((result) => {
      if (!result.ok) {  setState(failed(describePaymentError(result.error.message, language))); return }
      saveReceiptDocument(result.value)
    }, (error: unknown) => { setState(failed(describePaymentError(error instanceof Error ? error.message : String(error), language))) })
  }
  /**
   * Save Stripe's own receipt for an order.
   *
   * A separate read from `downloadReceipt` because these are two documents from
   * two issuers, and the Host exposes the second only where the backend says
   * Stripe holds one. The bytes are decoded the same way (base64), so the reason
   * it cannot replace the first is provenance, not transport.
   */
  const downloadStripeReceipt = (orderId: string): void => {
    if (paymentStripeReceiptDocument === undefined) return
    void paymentStripeReceiptDocument(orderId).then((result) => {
      if (!result.ok) {  setState(failed(describePaymentError(result.error.message, language))); return }
      saveReceiptDocument(result.value)
    }, (error: unknown) => { setState(failed(describePaymentError(error instanceof Error ? error.message : String(error), language))) })
  }
  /** The order card's own download button: same read, current order. */
  const downloadCurrentOrderReceipt = (): void => {
    if (state.status !== 'ready' || state.order === undefined) return
    downloadReceipt(state.order.orderId)
  }
  /** The card's Stripe download: the list row's read, for the order it shows. */
  const downloadCurrentOrderStripeReceipt = (): void => {
    if (state.status !== 'ready' || state.order === undefined) return
    downloadStripeReceipt(state.order.orderId)
  }
  const submitLogout = (): void => {
    void logout().then((result) => {
      if (!result.ok) {  setState(failed(result.error.message)); return }
      clearRememberedLogin()
      setRememberLogin(false)
      setPassword('')
      autoLoginAttempted.current = false
      load(true)
    }, (error: unknown) => { setState(failed(error instanceof Error ? error.message : String(error))) })
  }
  /**
   * Read the account exactly as the backend reports it.
   *
   * Every other figure on this page is a projection: balances, plan names and
   * provider readiness are normalized here. When one of them disagrees with what
   * a user sees on the website, the raw snapshot is the artifact that settles it,
   * and until now it was reachable only from the model's tool surface.
   */
  const showDiagnostics = (): void => {
    if (accountDetail === undefined || diagnosticsBusy) return
    setDiagnosticsBusy(true)
    void accountDetail().then((result) => {
      if (!result.ok) { setState(previous => previous.status === 'ready' ? { ...previous, actionError: result.error.message } : previous); return }
      setDiagnostics(result.value)
    }, (error: unknown) => { setState(previous => previous.status === 'ready' ? { ...previous, actionError: error instanceof Error ? error.message : String(error) } : previous) }).finally(() => { setDiagnosticsBusy(false) })
  }
  /**
   * The rejection arm every Agnes action shares.
   *
   * The read failures these handlers already map through `describeAgnesError`
   * covered a *failed result*; a rejected call is the Host being unreachable, and
   * it reached the console as an unhandled rejection while the card kept the old
   * text. The mapping is the same, so a disconnect reads like any other failure of
   * the same button.
   */
  const agnesFailure = (error: unknown): void => {
    setState(previous => previous.status === 'ready' ? { ...previous, actionError: describeAgnesError(error instanceof Error ? error.message : String(error)) } : previous)
  }

  const loginAgnes = (): void => {
    if (agnesLogin === undefined) return
    void agnesLogin(agnesEmail, agnesPassword).then((result) => { if (!result.ok) setState(previous => previous.status === 'ready' ? { ...previous, actionError: describeAgnesError(result.error.message) } : previous); else { setAgnesPassword(''); load(true) } }, agnesFailure)
  }
  const registerAgnes = (): void => {
    if (agnesRegister === undefined) return
    void agnesRegister(agnesEmail, agnesPassword, agnesCode).then((result) => { if (!result.ok) setState(previous => previous.status === 'ready' ? { ...previous, actionError: describeAgnesError(result.error.message) } : previous); else { setAgnesPassword(''); setAgnesCode(''); load(true) } }, agnesFailure)
  }
  const sendAgnesCode = (): void => {
    if (agnesSendVerification === undefined) return
    if (agnesRegisterCooldown > 0) return
    void agnesSendVerification(agnesEmail).then((result) => { if (!result.ok) { setState(previous => previous.status === 'ready' ? { ...previous, actionError: describeAgnesError(result.error.message) } : previous); if (/RATE_LIMITED|too frequently/i.test(result.error.message)) setAgnesRegisterCooldown(60) } else setAgnesRegisterCooldown(60) }, agnesFailure)
  }
  const sendAgnesResetCode = (): void => {
    if (agnesSendPasswordReset === undefined) return
    if (agnesResetCooldown > 0) return
    void agnesSendPasswordReset(agnesResetEmail).then((result) => { if (!result.ok) { setState(previous => previous.status === 'ready' ? { ...previous, actionError: describeAgnesError(result.error.message) } : previous); if (/RATE_LIMITED|too frequently/i.test(result.error.message)) setAgnesResetCooldown(60) } else setAgnesResetCooldown(60) }, agnesFailure)
  }
  const resetAgnesPassword = (): void => {
    if (agnesResetPassword === undefined) return
    if (agnesResetPasswordValue !== agnesResetConfirm) { setState(previous => previous.status === 'ready' ? { ...previous, actionError: '两次输入的新密码不一致' } : previous); return }
    void agnesResetPassword(agnesResetEmail, agnesResetPasswordValue, agnesResetCode).then((result) => {
      if (!result.ok) setState(previous => previous.status === 'ready' ? { ...previous, actionError: describeAgnesError(result.error.message) } : previous)
      else { setAgnesPassword(''); setAgnesResetPasswordValue(''); setAgnesResetConfirm(''); setAgnesResetCode(''); setAgnesResetOpen(false); setState(previous => previous.status === 'ready' ? { ...previous, actionError: '密码已重置，请使用新密码登录' } : previous) }
    }, agnesFailure)
  }
  const logoutAgnes = (accountId?: string): void => { if (agnesLogout !== undefined) void agnesLogout(accountId).then(() => { load(true) }, agnesFailure) }
  const removeAgnes = (accountId: string): void => { if (agnesRemoveAccount !== undefined) void agnesRemoveAccount(accountId).then((result) => { if (!result.ok) setState(previous => previous.status === 'ready' ? { ...previous, actionError: result.error.message } : previous); else load(true) }, agnesFailure) }
  const refreshAgnes = (accountId?: string): void => { if (agnesRefresh !== undefined) void agnesRefresh(accountId).then((result) => { if (!result.ok) setState(previous => previous.status === 'ready' ? { ...previous, actionError: result.error.message } : previous); else load(true) }, agnesFailure) }
  const [agnesCreateBusy, setAgnesCreateBusy] = useState(false)
  const createAgnesKey = (accountId: string): void => {
    if (agnesCreateApiKey === undefined || agnesCreateBusy) return
    setAgnesCreateBusy(true)
    void agnesCreateApiKey(accountId).then((result) => {
      if (!result.ok) setState(previous => previous.status === 'ready' ? { ...previous, actionError: describeAgnesError(result.error.message) } : previous)
      else load(true)
    }, (error: unknown) => { setState(previous => previous.status === 'ready' ? { ...previous, actionError: describeAgnesError(error instanceof Error ? error.message : String(error)) } : previous) }).finally(() => { setAgnesCreateBusy(false) })
  }
  // Cline free routes are served from a Host account pool, so the card owns a
  // pool manager (add/remove/refresh) rather than a single credential field.
  // The manual refresh-token paste is gone: the button starts the WorkOS device
  // login and the Host opens the authorization page in the system browser.
  const [clinePanelOpen, setClinePanelOpen] = useState(false)
  const [clineTicket, setClineTicket] = useState<ClineDeviceLogin | undefined>(undefined)
  const [clineBusy, setClineBusy] = useState(false)
  const startClineLogin = (): void => {
    if (clineStartLogin === undefined || clineBusy) return
    setClineBusy(true)
    void clineStartLogin().then((result) => {
      if (!result.ok) setState(failed(describeClineError(result.error.message)))
      else setClineTicket(result.value)
    }, (error: unknown) => { setState(failed(describeClineError(error instanceof Error ? error.message : String(error)))) }).finally(() => { setClineBusy(false) })
  }
  const removeClineAccount = (accountId: string): void => {
    if (clineRemoveAccount === undefined) return
    void clineRemoveAccount(accountId).then((result) => { if (!result.ok) setState(failed(describeClineError(result.error.message))); else load(true) }, (error: unknown) => { setState(failed(describeClineError(error instanceof Error ? error.message : String(error)))) })
  }
  const refreshCline = (accountId?: string): void => {
    if (clineRefresh === undefined) return
    setClineBusy(true)
    void clineRefresh(accountId).then((result) => {
      if (!result.ok) setState(failed(describeClineError(result.error.message)))
      else load(true)
    }, (error: unknown) => { setState(failed(describeClineError(error instanceof Error ? error.message : String(error)))) }).finally(() => { setClineBusy(false) })
  }
  const logoutCline = (): void => {
    if (clineLogout === undefined) return
    void clineLogout().then((result) => { if (!result.ok) setState(failed(describeClineError(result.error.message))); else { setClineTicket(undefined); load(true) } }, (error: unknown) => { setState(failed(describeClineError(error instanceof Error ? error.message : String(error)))) })
  }
  // A device login is finished in the browser, so the page polls one step at a
  // time. The Host deliberately does not hold a multi-minute request open.
  useEffect(() => {
    if (clineTicket === undefined || clinePollLogin === undefined) return
    let cancelled = false
    const poll = (): void => {
      if (Date.now() > clineTicket.expiresAt) {
        setClineTicket(undefined)
        setState(failed('登录码已过期，请重新开始添加账号。'))
        return
      }
      void clinePollLogin(clineTicket.deviceCode).then((result) => {
        if (cancelled) return
        if (!result.ok) { setClineTicket(undefined); setState(failed(describeClineError(result.error.message))); return }
        if (result.value.pending) return
        setClineTicket(undefined)
        load(true)
      }, (error: unknown) => {
        if (cancelled) return
        setClineTicket(undefined)
        setState(failed(describeClineError(error instanceof Error ? error.message : String(error))))
      })
    }
    const timer = globalThis.setInterval(poll, Math.max(3, clineTicket.intervalSeconds) * 1_000)
    return () => { cancelled = true; globalThis.clearInterval(timer) }
  }, [clineTicket, clinePollLogin])

  // WorkBuddy International mirrors the Cline device flow: the button opens
  // the console sign-in (Keycloak: OneID/WeChat/Google/GitHub) with a random
  // state, and the page polls until the upstream issues tokens for that state.
  // The desktop-credential import stays as a fallback for offline setups.
  const [workbuddyPanelOpen, setWorkbuddyPanelOpen] = useState(false)
  const [workbuddyTicket, setWorkbuddyTicket] = useState<WorkBuddyBrowserLogin | undefined>(undefined)
  const [workbuddyBusy, setWorkbuddyBusy] = useState(false)
  // WorkBuddy authorization finishes in the browser, so the page polls one
  // step at a time on its own clock; the Host never holds a long request open.
  useEffect(() => {
    if (workbuddyTicket === undefined || workbuddyPollBrowserLogin === undefined) return
    let cancelled = false
    const poll = (): void => {
      if (Date.now() > workbuddyTicket.expiresAt) {
        setWorkbuddyTicket(undefined)
        setState(failed(language === 'zh' ? '授权已超时，请重新点击「使用 WorkBuddy 账号登录」。' : 'Authorization timed out. Click Sign in again.'))
        return
      }
      void workbuddyPollBrowserLogin(workbuddyTicket.state).then((result) => {
        if (cancelled) return
        if (!result.ok) { setWorkbuddyTicket(undefined); setState(failed(describeWorkbuddyError(result.error.message))); return }
        if (result.value.pending) return
        setWorkbuddyTicket(undefined)
        load(true)
      }, (error: unknown) => {
        if (cancelled) return
        setWorkbuddyTicket(undefined)
        setState(failed(describeWorkbuddyError(error instanceof Error ? error.message : String(error))))
      })
    }
    const timer = globalThis.setInterval(poll, 3_000)
    return () => { cancelled = true; globalThis.clearInterval(timer) }
  }, [workbuddyTicket, workbuddyPollBrowserLogin, language])
  const startWorkbuddyLogin = (): void => {
    if (workbuddyStartBrowserLogin === undefined || workbuddyBusy) return
    setWorkbuddyBusy(true)
    void workbuddyStartBrowserLogin().then((result) => {
      if (!result.ok) setState(failed(describeWorkbuddyError(result.error.message)))
      else setWorkbuddyTicket(result.value)
    }, (error: unknown) => { setState(failed(describeWorkbuddyError(error instanceof Error ? error.message : String(error)))) }).finally(() => { setWorkbuddyBusy(false) })
  }
  const importWorkbuddyLogin = (): void => {
    if (workbuddyImportDesktopLogin === undefined || workbuddyBusy) return
    setWorkbuddyBusy(true)
    void workbuddyImportDesktopLogin().then((result) => {
      if (!result.ok) setState(failed(describeWorkbuddyError(result.error.message)))
      else load(true)
    }, (error: unknown) => { setState(failed(describeWorkbuddyError(error instanceof Error ? error.message : String(error)))) }).finally(() => { setWorkbuddyBusy(false) })
  }
  const removeWorkbuddyAccount = (accountId: string): void => {
    if (workbuddyRemoveAccount === undefined) return
    void workbuddyRemoveAccount(accountId).then((result) => { if (!result.ok) setState(failed(describeWorkbuddyError(result.error.message))); else load(true) }, (error: unknown) => { setState(failed(describeWorkbuddyError(error instanceof Error ? error.message : String(error)))) })
  }
  /**
   * Make one of the signed-in accounts the active one.
   *
   * Without this the pool was read-only from the surface: accounts could be
   * added and removed while the choice of which one serves a request stayed on
   * whatever the Host had picked, so a spent or rate-limited account could only
   * be worked around by removing it.
   */
  const useWorkbuddyAccount = (accountId: string): void => {
    if (workbuddySetActiveAccount === undefined || workbuddyBusy) return
    setWorkbuddyBusy(true)
    void workbuddySetActiveAccount(accountId).then((result) => {
      if (!result.ok) setState(failed(describeWorkbuddyError(result.error.message)))
      else load(true)
    }, (error: unknown) => { setState(failed(describeWorkbuddyError(error instanceof Error ? error.message : String(error)))) }).finally(() => { setWorkbuddyBusy(false) })
  }
  /** Every pool action reloads from the Host, because the sweep rewrites the
   * stored credits and check-in state the card renders. */
  const runWorkbuddyAction = (action: (() => Promise<RemoteResult<WorkBuddyInternationalStatus>>) | undefined): void => {
    if (action === undefined || workbuddyBusy) return
    setWorkbuddyBusy(true)
    void action().then((result) => {
      if (!result.ok) setState(failed(describeWorkbuddyError(result.error.message)))
      else load(true)
    }, (error: unknown) => { setState(failed(describeWorkbuddyError(error instanceof Error ? error.message : String(error)))) }).finally(() => { setWorkbuddyBusy(false) })
  }
  const refreshWorkbuddyCredits = (): void => { runWorkbuddyAction(workbuddyRefreshCredits) }
  const logoutWorkbuddy = (): void => {
    if (workbuddyLogout === undefined) return
    void workbuddyLogout().then((result) => { if (!result.ok) setState(failed(describeWorkbuddyError(result.error.message))); else load(true) }, (error: unknown) => { setState(failed(describeWorkbuddyError(error instanceof Error ? error.message : String(error)))) })
  }

  // Qoder mirrors the WorkBuddy browser flow: the Host mints a PKCE ticket,
  // opens the Qoder login page, and the page polls until the token is issued.
  const [qoderPanelOpen, setQoderPanelOpen] = useState(false)
  const [qoderTicket, setQoderTicket] = useState<QoderBrowserLogin | undefined>(undefined)
  const [qoderBusy, setQoderBusy] = useState(false)
  useEffect(() => {
    if (qoderTicket === undefined || qoderPollBrowserLogin === undefined) return
    let cancelled = false
    // One poll at a time. A ticket is exchanged once at the Host, and the page's
    // 3-second timer used to stack a second call on top of an exchange that was
    // still running (it reads the token, the identity, the plan, the vault, and
    // the model directory, so seconds is normal). The Host now joins such a call
    // instead of exchanging the spent nonce again; keeping one call in flight
    // here is what makes that join the normal path rather than a rescue.
    let inFlight = false
    const poll = (): void => {
      if (inFlight) return
      if (Date.now() > qoderTicket.expiresAt) {
        setQoderTicket(undefined)
        setState(failed(language === 'zh' ? '授权已超时，请重新点击「使用 Qoder 账号登录」。' : 'Authorization timed out. Click Sign in again.'))
        return
      }
      inFlight = true
      void qoderPollBrowserLogin(qoderTicket.state).then((result) => {
        inFlight = false
        if (cancelled) return
        if (!result.ok) {
          setQoderTicket(undefined)
          // The Host answers a finished sign-in with the account state, so this
          // is a ticket it no longer holds (a restart, an expired window). Say
          // so — the page owes the user a reason, not a silent signed-out card.
          setState(failed(describeQoderError(result.error.message)))
          return
        }
        if (result.value.pending) return
        setQoderTicket(undefined)
        load(true)
      }, (error: unknown) => {
        inFlight = false
        if (cancelled) return
        setQoderTicket(undefined)
        setState(failed(describeQoderError(error instanceof Error ? error.message : String(error))))
      })
    }
    const timer = globalThis.setInterval(poll, 3_000)
    return () => { cancelled = true; globalThis.clearInterval(timer) }
  }, [qoderTicket, qoderPollBrowserLogin, language])
  const startQoderLogin = (): void => {
    if (qoderStartBrowserLogin === undefined || qoderBusy) return
    setQoderBusy(true)
    void qoderStartBrowserLogin().then((result) => {
      if (!result.ok) setState(failed(describeQoderError(result.error.message)))
      else setQoderTicket(result.value)
    }, (error: unknown) => { setState(failed(describeQoderError(error instanceof Error ? error.message : String(error)))) }).finally(() => { setQoderBusy(false) })
  }
  const runQoderAction = (action: (() => Promise<RemoteResult<QoderStatus>>) | undefined): void => {
    if (action === undefined || qoderBusy) return
    setQoderBusy(true)
    void action().then((result) => {
      if (!result.ok) setState(failed(describeQoderError(result.error.message)))
      else load(true)
    }, (error: unknown) => { setState(failed(describeQoderError(error instanceof Error ? error.message : String(error)))) }).finally(() => { setQoderBusy(false) })
  }
  const refreshQoderQuota = (): void => { runQoderAction(qoderRefreshQuota) }
  const useQoderAccount = (accountId: string): void => {
    if (qoderSetActiveAccount === undefined || qoderBusy) return
    setQoderBusy(true)
    void qoderSetActiveAccount(accountId).then((result) => {
      if (!result.ok) setState(failed(describeQoderError(result.error.message)))
      else load(true)
    }, (error: unknown) => { setState(failed(describeQoderError(error instanceof Error ? error.message : String(error)))) }).finally(() => { setQoderBusy(false) })
  }
  const removeQoderAccount = (accountId: string): void => {
    if (qoderRemoveAccount === undefined) return
    void qoderRemoveAccount(accountId).then((result) => { if (!result.ok) setState(failed(describeQoderError(result.error.message))); else load(true) }, (error: unknown) => { setState(failed(describeQoderError(error instanceof Error ? error.message : String(error)))) })
  }
  const logoutQoder = (): void => {
    if (qoderLogout === undefined) return
    void qoderLogout().then((result) => { if (!result.ok) setState(failed(describeQoderError(result.error.message))); else load(true) }, (error: unknown) => { setState(failed(describeQoderError(error instanceof Error ? error.message : String(error)))) })
  }

  // How often the card asks whether the authorization landed. Short, because the
  // answer changes exactly once, the exchange behind it is one round trip, and the
  // user is looking at the card waiting for it.
  const TRAE_LOGIN_POLL_MS = 1_500
  // Trae signs in the same way Qoder does — a Host-owned PKCE round trip — but
  // the loopback redirect is not guaranteed to reach this Host (a remote desktop,
  // a firewall), so the card also accepts the callback the user pastes back.
  const [traePanelOpen, setTraePanelOpen] = useState(false)
  const [traeBusy, setTraeBusy] = useState(false)
  const [traeCallback, setTraeCallback] = useState('')
  const [traeModels, setTraeModels] = useState<readonly TraeModel[]>([])
  const traeCatalogSignedIn = state.status === 'ready' && state.trae?.status === 'authenticated'
  useEffect(() => {
    if (!traeCatalogSignedIn || traeModels === undefined || loadTraeModels === undefined) return
    let cancelled = false
    // The directory is a convenience for the card's model tags; a failure leaves
    // the account section intact rather than raising an alert over a decoration.
    void loadTraeModels().then((result) => { if (!cancelled && result.ok) setTraeModels(result.value) }, () => {})
    return () => { cancelled = true }
  }, [traeCatalogSignedIn, loadTraeModels])
  // The injected props are rebuilt on every render of this section, so the poll
  // callback has to be read through a ref. Keyed on directly, it would make this
  // effect tear its own timer down and re-arm it on every render — and the panel
  // re-renders more often than the interval, so the timer never reached its first
  // tick and an authorization that had already finished sat unclaimed until the
  // user pasted the callback by hand.
  const traePollRef = useRef(traePollBrowserLogin)
  traePollRef.current = traePollBrowserLogin
  useEffect(() => {
    if (!traePending) return
    let cancelled = false
    let inFlight = false
    const poll = (): void => {
      const call = traePollRef.current
      if (inFlight || call === undefined) return
      inFlight = true
      void call().then((result) => {
        inFlight = false
        if (cancelled) return
        if (!result.ok) { setState(failed(describeTraeError(result.error.message))); return }
        if (result.value.status !== 'login-pending') load(true)
      }, (error: unknown) => {
        inFlight = false
        if (cancelled) return
        setState(failed(describeTraeError(error instanceof Error ? error.message : String(error))))
      })
    }
    // Once immediately: the Host completes the exchange the moment the redirect
    // lands, so the first ask is usually already the answer, and making the card
    // wait a whole interval for it is the dead time between authorizing and seeing
    // the account. Then on the interval, for the slower paths (a browser that has
    // not redirected yet, an exchange still in flight).
    poll()
    const timer = globalThis.setInterval(poll, TRAE_LOGIN_POLL_MS)
    return () => { cancelled = true; globalThis.clearInterval(timer) }
  }, [traePending, language])
  const applyTraeStatus = (trae: TraeStatus): void => {
    setState((previous) => previous.status === 'ready' ? { ...previous, trae } : previous)
  }
  const runTraeAction = (action: (() => Promise<RemoteResult<TraeStatus>>) | undefined): void => {
    if (action === undefined || traeBusy) return
    setTraeBusy(true)
    void action().then((result) => {
      if (!result.ok) { setState(failed(describeTraeError(result.error.message))); return }
      // The answered status is the Host's own view, so it is painted as given.
      // Refreshing instead of painting would round-trip a value the Host just
      // handed back, and an in-flight authorization is the case that cannot
      // tolerate it: the attempt lives in the Host, so a refresh racing it can
      // put a stale snapshot where the pending banner belongs.
      applyTraeStatus(result.value)
      if (result.value.status !== 'login-pending') load(true)
    }, (error: unknown) => { setState(failed(describeTraeError(error instanceof Error ? error.message : String(error)))) }).finally(() => { setTraeBusy(false) })
  }
  const startTraeLogin = (realm: 'cn' | 'sg'): void => {
    if (traeStartBrowserLogin === undefined || traeBusy) return
    setTraeBusy(true)
    void traeStartBrowserLogin(realm).then((result) => {
      if (!result.ok) setState(failed(describeTraeError(result.error.message)))
      // Painting the answered status is what puts the card into `登录中` for the
      // realm that was just authorized, without a second round trip.
      else applyTraeStatus(result.value)
    }, (error: unknown) => { setState(failed(describeTraeError(error instanceof Error ? error.message : String(error)))) }).finally(() => { setTraeBusy(false) })
  }
  const cancelTraeLogin = (): void => { runTraeAction(traeCancelBrowserLogin) }
  const logoutTrae = (): void => { runTraeAction(traeLogout) }
  const submitTraeCallback = (): void => {
    if (traeSubmitCallback === undefined || traeBusy) return
    setTraeBusy(true)
    void traeSubmitCallback(traeCallback.trim()).then((result) => {
      if (!result.ok) { setState(failed(describeTraeError(result.error.message))); return }
      setTraeCallback('')
      applyTraeStatus(result.value)
      if (result.value.status !== 'login-pending') load(true)
    }, (error: unknown) => { setState(failed(describeTraeError(error instanceof Error ? error.message : String(error)))) }).finally(() => { setTraeBusy(false) })
  }

  // A check-in is a run over the whole pool, not a property of one account: the
  // gesture is "collect today's credits", and the report is what says which
  // account could not. The last report is kept so its line survives a re-render.
  const [qoderCheckinReport, setQoderCheckinReport] = useState<FreeCodeGoCheckinReport | undefined>(undefined)
  const [traeCheckinReport, setTraeCheckinReport] = useState<FreeCodeGoCheckinReport | undefined>(undefined)
  const [qoderCheckinBusy, setQoderCheckinBusy] = useState(false)
  const [traeCheckinBusy, setTraeCheckinBusy] = useState(false)
  const runCheckin = (
    remote: (() => Promise<RemoteResult<FreeCodeGoCheckinReport>>) | undefined,
    busy: boolean,
    setReport: (report: FreeCodeGoCheckinReport) => void,
    setBusy: (busy: boolean) => void,
    describe: (detail: string) => string,
  ): void => {
    if (remote === undefined || busy) return
    setBusy(true)
    void remote().then((result) => {
      // A refusal from the run as a whole (the pool missing, the vault gone) is an
      // error; a refusal from one account is a line inside the report.
      if (!result.ok) setState(failed(describe(result.error.message)))
      else setReport(result.value)
    }, (error: unknown) => { setState(failed(describe(error instanceof Error ? error.message : String(error)))) }).finally(() => { setBusy(false) })
  }
  const claimQoderCredits = (): void => { runCheckin(runQoderCheckin, qoderCheckinBusy, setQoderCheckinReport, setQoderCheckinBusy, describeQoderError) }
  const claimTraeCredits = (): void => { runCheckin(runTraeCheckin, traeCheckinBusy, setTraeCheckinReport, setTraeCheckinBusy, describeTraeError) }
  return (
    <section className={css.root} aria-busy={state.syncStatus === 'refreshing'}>
      <header className={css.toolbar}>
        <div className={css.toolbarTitle}><div className={css.kicker}>FreeCodeGo</div><h2 className={css.title}>{t('title')}</h2></div>
        <button className={css.toolbarAction} type="button" onClick={() => { load(true) }}>{t('refresh')}</button>
      </header>
      {state.status === 'ready' && state.syncStatus === 'refreshing' ? <div className={css.syncNotice} role="status"><span className={css.syncDot} />{language === 'zh' ? '正在同步账户、引擎与模型数据，已显示本地可用内容。' : 'Syncing account, engine, and model data. Local content remains available.'}</div> : null}
      {state.status === 'ready' && state.syncStatus === 'offline' ? <div className={`${css.syncNotice} ${css.syncNoticeOffline}`} role="alert"><span className={css.syncDot} />{language === 'zh' ? `暂时无法同步远程数据，页面与已有数据保持可用。${state.syncError === undefined ? '' : ` ${state.syncError}`}` : `Remote data is temporarily unavailable. The page and existing data remain available.${state.syncError === undefined ? '' : ` ${state.syncError}`}`}</div> : null}
      {state.status === 'ready' && state.account.status === 'reauth-required' ? <div className={`${css.syncNotice} ${css.syncNoticeOffline}`} role="status"><span className={css.syncDot} />{language === 'zh' ? 'FreeCodeGo 登录状态已过期，请在下方重新登录。' : 'Your FreeCodeGo sign-in has expired. Sign in again below.'}</div> : null}
      {state.status === 'ready' && state.actionError !== undefined ? <div className={css.alert} role="alert"><span>{state.actionError}</span><button className={css.button} type="button" onClick={() => { setState((previous) => { if (previous.status !== 'ready') return previous; const { actionError: _cleared, ...rest } = previous; return rest }) }}>{language === 'zh' ? '知道了' : 'Dismiss'}</button></div> : null}
      {state.status === 'ready' ? <div className={css.sections}>
        <nav className={css.pageTabs} aria-label={language === 'zh' ? 'FreeCodeGo 设置页面' : 'FreeCodeGo settings pages'}>
          <button className={`${css.pageTab} ${settingsPage === 'overview' ? css.pageTabActive : ''}`} type="button" onClick={() => { setSettingsPage('overview') }}>{language === 'zh' ? '概览' : 'Overview'}</button>
          <button className={`${css.pageTab} ${settingsPage === 'providers' ? css.pageTabActive : ''}`} type="button" onClick={() => { setSettingsPage('providers') }}>{language === 'zh' ? '账号与提供商' : 'Accounts and providers'}</button>
          <button className={`${css.pageTab} ${settingsPage === 'community' ? css.pageTabActive : ''}`} type="button" onClick={() => { setSettingsPage('community') }}>{language === 'zh' ? '社区精选' : 'Community'}</button>
          <button className={`${css.pageTab} ${settingsPage === 'settings' ? css.pageTabActive : ''}`} type="button" onClick={() => { setSettingsPage('settings') }}>{language === 'zh' ? '设置' : 'Settings'}</button>
        </nav>
        {settingsPage === 'community' && capabilityMarketplace !== undefined && mcpPresetInstall !== undefined && skillPresetInstall !== undefined ? <CommunityPluginsPage communityCatalog={communityCatalog} communityCatalogIcons={communityCatalogIcons} communityEnvironment={communityEnvironment} communityInstalled={communityInstalled} communityInstall={communityInstall} communityUninstall={communityUninstall} capabilityMarketplace={capabilityMarketplace} mcpPresetInstall={mcpPresetInstall} skillPresetInstall={skillPresetInstall} skillPresetRemove={skillPresetRemove} skillPlacements={skillPlacements} skillPlacementPrefer={skillPlacementPrefer} language={language} /> : null}
        {settingsPage === 'settings' ? <ModelCategorySettingsPage models={nativeModels} categories={capabilitySnapshot?.modelCategories ?? {}} setCategory={modelCategorySet} language={language} onSnapshot={(snapshot) => { setCapabilitySnapshot(snapshot); publishCapabilitySnapshot(snapshot) }} onError={(message) => { setState(previous => previous.status === 'ready' ? { ...previous, actionError: message } : previous) }} /> : null}
        {settingsPage === 'settings' ? <><PluginConflictProtection status={pluginConflictStatus} setEnabled={pluginConflictSetEnabled} /><HeadroomPanel status={headroomStatus} setEnabled={headroomSetEnabled} update={headroomUpdate} language={language} /><MediaGenerationPanel status={mediaGenerationStatus} setEnabled={mediaGenerationSetEnabled} language={language} /><DeferredToolsPanel status={deferredToolsStatus} setEnabled={deferredToolsSetEnabled} language={language} /><ReviewPanel sessionId={currentSessionId?.()} status={reviewStatus} start={reviewStart} update={reviewUpdate} language={language} /><GuardSettingsPanel status={guardSettingsStatus} update={guardSettingsUpdate} language={language} /><SandboxModePanel sessionId={currentSessionId?.()} status={sandboxModeStatus} setMode={sandboxModeSet} language={language} /><TrustPanel status={trustFolderStatus} grant={trustFolderGrant} revoke={trustFolderRevoke} projectConfig={projectConfigReport} language={language} /><AutomationSettingsPanel status={automationSettingsStatus} update={automationSettingsUpdate} language={language} /><PluginUpdateSettings status={pluginUpdateSnapshot} check={pluginUpdateCheck} setEnabled={pluginUpdateSetEnabled} install={pluginUpdateInstall} rollback={pluginUpdateRollback} language={language} /><CapabilitySettingsPage snapshot={capabilitySnapshot} setEnabled={capabilitiesSetEnabled} setLocalCapability={setLocalCapability} onSnapshot={(snapshot) => { setCapabilitySnapshot(snapshot); publishCapabilitySnapshot(snapshot) }} onError={(message) => { setState(previous => previous.status === 'ready' ? message === undefined ? previous : { ...previous, actionError: message } : previous) }} /><section className={css.section}><div className={css.sectionHeader}><div><div className={css.kicker}>Advisor</div><strong className={css.sectionName}>Advisor 监督</strong></div><span className={`${css.badge} ${advisorSnapshot?.enabled ? css.badgeLive : ''}`}>{advisorSnapshot?.enabled ? '已启用' : '未启用'}</span></div><small className={css.sectionMeta}>仅在这里控制 Advisor 总开关。模型、审查模式和介入策略请从左侧 Advisor 页面配置。</small><div className={css.extensionList}><label className={css.extensionRow}><span><strong>启用 Advisor</strong><small>开启后，Host 会在主 Agent 回合完成后执行独立复核。</small></span><input className={css.switch} aria-label="启用 Advisor" type="checkbox" checked={advisorSnapshot?.enabled === true} onChange={(event) => { toggleAdvisor(event.target.checked) }} disabled={advisorUpdate === undefined || advisorToggleBusy} /></label>{advisorSnapshot?.sideChannelWarnings?.map(warning => <div className={css.accountRow} key={warning}><div className={css.accountIdentity}><strong className={css.accountName}>{language === 'zh' ? '侧信道预算' : 'Side-channel budget'}</strong><small>{warning}</small></div></div>)}</div></section></> : null}
        {settingsPage === 'settings' ? <section className={css.section}><div className={css.sectionHeader}><div><div className={css.kicker}>ENGINEERING</div><strong className={css.sectionName}>工程增强包</strong></div><span className={`${css.badge} ${engineeringSnapshot?.engineeringEnabled ? css.badgeLive : ''}`}>{engineeringSnapshot?.engineeringEnabled ? '已启用' : '未启用'}</span></div><small className={css.sectionMeta}>这里只控制总开关。开启后，工程 Skills、项目长期记忆和代码结构图会在左侧工程页面中管理。</small><div className={css.extensionList}><label className={css.extensionRow}><span><strong>启用工程增强包</strong><small>开启后 AI 会持续理解当前项目，并在不同 Agent 之间共享上下文。</small></span><input className={css.switch} aria-label="启用工程增强包" type="checkbox" checked={engineeringSnapshot?.engineeringEnabled === true} onChange={(event) => { toggleEngineering(event.target.checked) }} disabled={engineeringSetEnabled === undefined || engineeringToggleBusy} /></label></div></section> : null}
        {settingsPage === 'overview' ? <section className={css.section}>
          <div className={css.sectionHeader}><div><div className={css.kicker}>{t('runtime')}</div><strong className={css.sectionName}>{t('modelRouting')}</strong></div><span className={`${css.badge} ${css.badgeLive}`}>{t('live')}</span></div>
          <div className={`${css.grid} ${css.routingGrid}`}>
            <div className={`${css.infoCell} ${css.routingCell}`}><div className={css.routingCopy}><small className={css.cellLabel}>{t('provider')}</small><strong className={css.cellValue}>FreeCodeGo</strong><small className={css.cellHint}>{t('cloudRuntime')}</small></div></div>
            {setDefaultEngine === undefined ? null : <label className={`${css.infoCell} ${css.selectCell} ${css.routingCell}`}><div className={css.routingCopy}><small className={css.cellLabel}>{t('engineLabel')}</small><small className={css.cellHint}>{t('engineNewSessionOnly')}</small></div><select className={css.select} value={state.catalog.defaultEngine} onChange={(event) => { chooseEngine(event.target.value as 'deepseek' | 'codex' | 'claude') }}><option value="deepseek">{t('engineDeepseek')}</option><option value="codex" disabled={!state.catalog.engines.some(engine => engine.id === 'codex' && engine.availability === 'available')}>{t('engineCodex')}</option><option value="claude" disabled={!state.catalog.engines.some(engine => engine.id === 'claude' && engine.availability === 'available')}>{t('engineClaude')}</option></select></label>}
            {effectiveCatalog.models.length > 0 ? <div className={`${css.infoCell} ${css.selectCell} ${css.routingCell}`}>
              <div className={css.routingCopy}>
                <small className={css.cellLabel}>{modelCategory === 'text' ? t('defaultModel') : categoryLabel(modelCategory, language)}</small>
                <small className={css.cellHint}>{modelCategory === 'text' ? t('engineNewSessionOnly') : language === 'zh' ? '优先使用所选模型；仅在服务不可用时自动切换同类模型。' : 'Uses the selected model first and falls back only when its service is unavailable.'}</small>
                {modelCategory === 'text' && backendDefaultGroupName(effectiveCatalog.groups) !== undefined ? <small className={css.cellHint}>{language === 'zh' ? `未指定分组时使用后端默认分组「${backendDefaultGroupName(effectiveCatalog.groups)}」` : `Without a chosen group, requests use the backend default group “${backendDefaultGroupName(effectiveCatalog.groups)}”`}</small> : null}
              </div>
              <div className={css.pageTabs} role="tablist" aria-label={language === 'zh' ? '模型分类' : 'Model categories'}>
                {(['text', 'image', 'video', 'audio'] as const).map(category => <button className={`${css.pageTab} ${modelCategory === category ? css.pageTabActive : ''}`} type="button" key={category} onClick={() => { setModelCategory(category) }}>{categoryLabel(category, language)}</button>)}
              </div>
              <select className={css.select} value={categorySelection.value} onChange={(event) => { if (modelCategory === 'text') chooseModel(event.target.value); else void chooseMediaModel(modelCategory, event.target.value) }}>
                {selectedCategoryModel === '' ? <option value="">{textModelEmptyLabel(modelCategory, language)}</option> : null}
                {categorySelection.listed ? null : <option value={selectedCategoryModel}>{`${displayModelSelection(selectedCategoryModel)}${language === 'zh' ? '（当前不可用）' : ' (currently unavailable)'}`}</option>}
                {categoryProviderGroups.map(([groupLabel, rows]) => <optgroup key={groupLabel} label={groupLabel}>{rows.map(row => <option key={row.key} value={modelRowSelectionValue(row)}>{[cleanModelDisplayName(row.model.displayName, visibleModelId(row.model.provider, row.model.id)), pickerRowRateLabel(row, language)].filter(Boolean).join(' ')}</option>)}</optgroup>)}
              </select>
              <div className={css.modelCategoryActions}>
                <select className={css.select} aria-label={language === 'zh' ? '移动模型到当前分类' : 'Move a model into the current category'} value={modelMoveCandidate} onChange={(event) => { setModelMoveCandidate(event.target.value) }} disabled={setModelCategoryDirect === undefined}>
                  <option value="">{language === 'zh' ? '选择其他分类模型' : 'Choose a model from another category'}</option>
                  {categoryMoveCandidates.filter(model => model.category !== modelCategory).map(model => <option key={model.key} value={model.key}>{model.displayName} · {model.providerName} · {categoryLabel(model.category, language)}</option>)}
                </select>
                <button className={css.button} type="button" onClick={() => { moveModelToCategory(modelCategory) }} disabled={setModelCategoryDirect === undefined || modelMoveCandidate === ''}>{language === 'zh' ? '移动模型到此分类' : 'Move model to this category'}</button>
              </div>
            </div> : null}
          </div>
          <div className={`${css.infoCell} ${css.feedbackRow}`}>
            <div className={css.routingCopy}>
              <small className={css.cellLabel}>{t('communityFeedback')}</small>
              <strong className={css.cellValue}>{t('telegramGroup')}</strong>
              <small className={css.cellHint}>{t('telegramHint')}</small>
            </div>
            <a className={`${css.button} ${css.telegramLink}`} href="https://t.me/freecodego" target="_blank" rel="noopener noreferrer">
              <TelegramIcon />
              <span>{t('telegramJoin')}</span>
            </a>
          </div>
          {codexRuntimeStatus === undefined ? null : <div className={css.infoCell}><small className={css.cellLabel}>{t('codexAgent')}</small><strong className={css.cellValue}>{codexStatus?.installed ? t('installed') : t('optionalComponent')}</strong><small className={css.cellHint}>{codexStatus?.installed ? `${codexStatus.platform} · ${codexStatus.runtimeVersion ?? ''}` : (codexStatus?.reason ?? t('unavailable'))}</small><div className={css.accountActions}><button className={css.button} type="button" onClick={() => { openRuntimePicker('codex') }} disabled={codexBusy || codexStatus?.installed === true}>{codexBusy ? t('installing') : codexStatus?.installed ? t('installed') : t('installCodex')}</button>{codexStatus?.installed ? <button className={`${css.button} ${css.buttonDanger}`} type="button" onClick={removeCodex} disabled={codexBusy}>{t('remove')}</button> : null}</div>{runtimePicker === 'codex' ? <RuntimePackagePicker packages={codexPackages} busy={codexBusy} onCancel={() => { setRuntimePicker(undefined) }} onInstall={installCodex} language={language} t={t} /> : null}</div>}
          {claudeRuntimeStatus === undefined ? null : <div className={css.infoCell}><small className={css.cellLabel}>{t('engineClaude')}</small><strong className={css.cellValue}>{claudeStatus?.installed ? t('installed') : t('optionalComponent')}</strong><small className={css.cellHint}>{claudeStatus?.installed ? `${claudeStatus.platform} · ${claudeStatus.runtimeVersion ?? ''}` : (claudeStatus?.reason ?? t('unavailable'))}</small><div className={css.accountActions}><button className={css.button} type="button" onClick={() => { openRuntimePicker('claude') }} disabled={claudeBusy || claudeStatus?.installed === true}>{claudeBusy ? t('installing') : claudeStatus?.installed ? t('installed') : t('installClaude')}</button>{claudeStatus?.installed ? <button className={`${css.button} ${css.buttonDanger}`} type="button" onClick={removeClaude} disabled={claudeBusy}>{t('remove')}</button> : null}</div>{runtimePicker === 'claude' ? <RuntimePackagePicker packages={claudePackages} busy={claudeBusy} onCancel={() => { setRuntimePicker(undefined) }} onInstall={installClaude} language={language} t={t} /> : null}</div>}
        </section> : null}
        {settingsPage === 'providers' && vyceStatus !== undefined ? <ProviderCard
          language={language}
          name="VyceAI" visibility={providerVisibility('vyce')}
          title={language === 'zh' ? '每日签到免费额度 · 推荐' : 'Daily check-in credit · Recommended'}
          icon={<ProviderGlyph kind="vyce" />}
          status={{ label: state.vyce?.configured ? (language === 'zh' ? '已配置' : 'Configured') : (language === 'zh' ? '未配置' : 'Not configured'), tone: state.vyce?.configured ? 'live' : 'idle' }}
          summary={language === 'zh' ? '支持 OpenAI 与 Anthropic 双协议接口 · Claude 与 DeepSeek 引擎均可直连' : 'OpenAI and Anthropic compatible · works with both the Claude and DeepSeek engines'}
          models={vyceModelNames}
          modelsAreIdentifiers
          description={language === 'zh'
            ? '每天签到免费领 $10 额度，一个月最多 $300，约等于 5 个 OpenCode Go 订阅额度；同时支持 Claude 引擎（Anthropic /v1/messages）与 DeepSeek 引擎（OpenAI /v1/chat/completions）。Key 仅保存在 Harness Host。'
            : 'Claim $10 in free credits every day — up to $300 a month, roughly 5 OpenCode Go subscriptions. Serves both the Claude engine (Anthropic /v1/messages) and the DeepSeek engine (OpenAI /v1/chat/completions). The key stays in the Harness Host.'}
          actions={<>
            <a className={css.button} href="https://vyceai.com/signup?ref=VYCE_RBSBEV" target="_blank" rel="noopener noreferrer">{language === 'zh' ? '申请 API Key' : 'Get an API key'}</a>
            {state.vyce?.configured === true ? <button className={css.button} type="button" onClick={clearVyceKey} disabled={vyceBusy || vyceSetKey === undefined}>{language === 'zh' ? '清除 Key' : 'Clear key'}</button> : null}
          </>}
        >
          {vyceSetKey === undefined ? null : <div className={css.authForm}><input className={css.input} type="password" value={vyceKey} onChange={(event) => { setVyceKey(event.target.value) }} placeholder={language === 'zh' ? '粘贴 VyceAI API Key' : 'Paste your VyceAI API key'} autoComplete="off" /><button className={`${css.button} ${css.buttonPrimary}`} type="button" onClick={saveVyceKey} disabled={vyceBusy || vyceKey.trim() === ''}>{vyceBusy ? (language === 'zh' ? '保存中…' : 'Saving…') : (language === 'zh' ? '保存 Key' : 'Save key')}</button></div>}
        </ProviderCard> : null}
        {settingsPage === 'providers' && logfareStatus !== undefined && state.logfareSupported !== false ? <ProviderCard
          language={language}
          name="logfare" visibility={providerVisibility('logfare')}
          title={language === 'zh' ? '免费基础与高级模型' : 'Free standard and premium models'}
          icon={<ProviderGlyph kind="logfare" />}
          status={{
            label: state.logfare?.premiumUnlocked ? (language === 'zh' ? '全部模型可用' : 'All models available') : state.logfare?.configured ? (language === 'zh' ? '已连接' : 'Connected') : (language === 'zh' ? '未连接' : 'Not connected'),
            tone: state.logfare?.configured ? 'live' : 'idle',
          }}
          summary={state.logfare?.configured === true
            ? language === 'zh'
              ? `基础 ${state.logfare.standardModelCount} · 高级 ${state.logfare.premiumModelCount}`
              : `${state.logfare.standardModelCount} standard · ${state.logfare.premiumModelCount} premium`
            : undefined}
          models={logfareModelNames}
          description={language === 'zh'
            ? '凭证仅保存在 Harness Host，模型通过独立安全通道使用。'
            : 'Credentials stay in the Harness Host; models use a separate secured channel.'}
          actions={<>
            {state.logfare?.configured ? <button className={css.button} type="button" onClick={registerLogfare} disabled={logfareRegisterBusy}>{logfareRegisterBusy ? (language === 'zh' ? '申请中…' : 'Applying…') : (language === 'zh' ? '重新申请资格' : 'Re-apply')}</button>
              : <button className={`${css.button} ${css.buttonPrimary}`} type="button" onClick={registerLogfare} disabled={logfareRegisterBusy}>{logfareRegisterBusy ? (language === 'zh' ? '申请中…' : 'Applying…') : (language === 'zh' ? '申请资格并保存' : 'Apply and save')}</button>}
            {state.logfare?.sessionConfigured && !state.logfare.premiumUnlocked ? <button className={`${css.button} ${css.buttonPrimary}`} type="button" onClick={setLogfareTraining} disabled={logfareTrainingBusy} title={language === 'zh' ? '同意将清理后的请求与回复用于内部评估和模型训练。该同意不会向第三方分发内容；已用于训练的内容影响无法撤销。' : 'Agree to use cleaned requests and replies for internal evaluation and model training. This does not distribute content to third parties; training effects cannot be undone.'}>{logfareTrainingBusy ? (language === 'zh' ? '处理中…' : 'Working…') : (language === 'zh' ? '同意训练数据并解锁高级模型' : 'Unlock premium models')}</button> : null}
          </>}
          children={<>
            <small className={css.sectionMeta}>{state.logfare?.configured !== true
              ? (language === 'zh' ? '尚未连接。可以申请资格，或者用下面的输入框填一个已在别处拿到的 Key。' : 'Not connected yet. Apply, or enter a key you already have below.')
              : state.logfare.premiumUnlocked ? (language === 'zh' ? '基础与高级模型均可从模型列表选择。' : 'Standard and premium models are selectable from the model list.') : state.logfare.sessionConfigured ? (language === 'zh' ? '同意训练数据后即可解锁高级模型。' : 'Agree to training data to unlock premium models.') : (language === 'zh' ? '申请资格后会自动保存凭证。' : 'Applying saves the credential automatically.')}</small>
            {logfareSetKey === undefined ? null : <details className={css.advisorManual}><summary>{language === 'zh' ? '手动填入手上的 Logfare Key' : 'Enter an existing Logfare key'}</summary><small>{language === 'zh' ? '凭证只保存在 Harness Host，不会回显。' : 'The credential is stored in the Harness Host only and is never echoed back.'}</small><div className={css.capabilityForm}><label><span>{language === 'zh' ? 'Logfare Key' : 'Logfare key'}</span><input className={css.input} type="password" autoComplete="off" aria-label={language === 'zh' ? 'Logfare Key' : 'Logfare key'} value={logfareKey} onChange={(event) => { setLogfareKey(event.target.value) }} /></label><button className={css.button} type="button" onClick={saveLogfareKey} disabled={logfareKeyBusy || logfareKey.trim() === ''}>{logfareKeyBusy ? (language === 'zh' ? '保存中…' : 'Saving…') : (language === 'zh' ? '保存 Key' : 'Save key')}</button></div></details>}
          </>}
        /> : null}
        {settingsPage === 'providers' && sensenovaStatus !== undefined ? <ProviderCard
          language={language}
          name="SenseNova" visibility={providerVisibility('sensenova')}
          title={language === 'zh' ? '公测免费模型' : 'Public beta free models'}
          icon={<ProviderGlyph kind="sensenova" />}
          status={{ label: state.sensenova?.configured ? (language === 'zh' ? '已配置' : 'Configured') : (language === 'zh' ? '未配置' : 'Not configured'), tone: state.sensenova?.configured ? 'live' : 'idle' }}
          summary={sensenovaModelNames.length === 0 ? undefined : language === 'zh' ? `已接入 ${sensenovaModelNames.length} 个模型` : `${sensenovaModelNames.length} models available`}
          models={sensenovaModelNames}
          description={language === 'zh'
            ? '5 小时额度 60,000 积分，周额度 600,000 积分；Key 仅保存在 Harness Host。'
            : '60,000 credits per 5 hours and 600,000 per week. The key stays in the Harness Host.'}
          actions={<>
            <a className={css.button} href="https://platform.sensenova.cn/console/keys" target="_blank" rel="noopener noreferrer">{language === 'zh' ? '申请 API Key' : 'Get an API key'}</a>
            {state.sensenova?.configured === true ? <button className={css.button} type="button" onClick={clearSensenovaKey} disabled={sensenovaBusy || sensenovaSetKey === undefined}>{language === 'zh' ? '清除 Key' : 'Clear key'}</button> : null}
          </>}
        >
          {sensenovaSetKey === undefined ? null : <div className={css.authForm}><input className={css.input} type="password" value={sensenovaKey} onChange={(event) => { setSensenovaKey(event.target.value) }} placeholder={language === 'zh' ? '粘贴 SenseNova API Key' : 'Paste your SenseNova API key'} autoComplete="off" /><button className={`${css.button} ${css.buttonPrimary}`} type="button" onClick={saveSensenovaKey} disabled={sensenovaBusy || sensenovaKey.trim() === ''}>{sensenovaBusy ? (language === 'zh' ? '保存中…' : 'Saving…') : (language === 'zh' ? '保存 Key' : 'Save key')}</button></div>}
        </ProviderCard> : null}
        {settingsPage === 'providers' && nvidiaStatus !== undefined ? <ProviderCard
          language={language}
          name="NVIDIA NIM" visibility={providerVisibility('nvidia')}
          title={language === 'zh' ? '高级免费模型' : 'Free premium models'}
          icon={<ProviderGlyph kind="nvidia" />}
          status={{ label: state.nvidia?.configured ? (language === 'zh' ? '已配置' : 'Configured') : (language === 'zh' ? '未配置' : 'Not configured'), tone: state.nvidia?.configured ? 'live' : 'idle' }}
          summary={nvidiaModelNames.length === 0 ? undefined : language === 'zh' ? `${nvidiaModelNames.length} 个免费模型` : `${nvidiaModelNames.length} free models`}
          models={nvidiaModelNames}
          description={language === 'zh'
            ? '通过 build.nvidia.com 的免费额度调用 NIM 推理端点；Key 仅保存在 Harness Host。'
            : 'Calls the NIM inference endpoint through the build.nvidia.com free tier. The key stays in the Harness Host.'}
          actions={<>
            <a className={css.button} href="https://build.nvidia.com" target="_blank" rel="noopener noreferrer">{language === 'zh' ? '申请 API Key' : 'Get an API key'}</a>
            {state.nvidia?.configured === true ? <button className={css.button} type="button" onClick={clearNvidiaKey} disabled={nvidiaBusy || nvidiaSetKey === undefined}>{language === 'zh' ? '清除 Key' : 'Clear key'}</button> : null}
          </>}
        >
          {nvidiaSetKey === undefined ? null : <div className={css.authForm}><input className={css.input} type="password" value={nvidiaKey} onChange={(event) => { setNvidiaKey(event.target.value) }} placeholder={language === 'zh' ? '粘贴 NVIDIA API Key' : 'Paste your NVIDIA API key'} autoComplete="off" /><button className={`${css.button} ${css.buttonPrimary}`} type="button" onClick={saveNvidiaKey} disabled={nvidiaBusy || nvidiaKey.trim() === ''}>{nvidiaBusy ? (language === 'zh' ? '保存中…' : 'Saving…') : (language === 'zh' ? '保存 Key' : 'Save key')}</button></div>}
        </ProviderCard> : null}
        {settingsPage === 'providers' && agnesStatus !== undefined ? <ProviderCard
          language={language}
          name="Agnes AI" visibility={providerVisibility('agnes')}
          title={language === 'zh' ? '文本模型与账号' : 'Text models and accounts'}
          icon={<ProviderGlyph kind="agnes" />}
          status={{ label: state.agnes?.status === 'authenticated' ? (language === 'zh' ? '已登录' : 'Signed in') : (language === 'zh' ? '未登录' : 'Signed out'), tone: state.agnes?.status === 'authenticated' ? 'live' : 'idle' }}
          summary={state.agnes?.status === 'authenticated'
            ? language === 'zh' ? `已登录 ${state.agnes.accounts.length} 个账号` : `${state.agnes.accounts.length} accounts signed in`
            : undefined}
          models={agnesModelNames}
          description={state.agnes?.status === 'authenticated'
            ? language === 'zh' ? '账号自动轮询；媒体模型在「设置 → 模型分类」中配置。' : 'Accounts rotate automatically. Media models are configured under Settings → Model categories.'
            : language === 'zh' ? '登录后可在此创建 API Key 并参与轮询。' : 'Sign in to create an API key and join the rotation.'}
          actions={<>
            <button className={css.button} type="button" onClick={() => { setAgnesManagerOpen(open => !open) }} aria-expanded={agnesManagerOpen}>{state.agnes?.status === 'authenticated' ? (language === 'zh' ? `账号管理（${state.agnes.accounts.length}）` : `Manage accounts (${state.agnes.accounts.length})`) : (language === 'zh' ? '添加账号' : 'Add account')}</button>
            {state.agnes?.status === 'authenticated' ? <button className={`${css.button} ${css.buttonDanger}`} type="button" onClick={() => { logoutAgnes() }}>{language === 'zh' ? '退出全部' : 'Sign out all'}</button> : null}
          </>}
        >
          {agnesManagerOpen ? <div className={css.accountManager}>
            {state.agnes?.status === 'authenticated' ? <div className={css.accountList}>{state.agnes.accounts.map(account => <div className={css.accountRow} key={account.id}><div className={css.accountIdentity}><strong className={css.accountName}>{account.email ?? account.username ?? account.id}</strong><small className={css.accountEmail}>{account.reauthRequired === true ? (language === 'zh' ? '会话已失效，请重新登录该账号' : 'Session expired; sign in again for this account') : account.apiKeyConfigured ? (language === 'zh' ? 'Key 已创建，可参与轮询' : 'Key created; in rotation') : (language === 'zh' ? '缺少 API Key' : 'No API key yet')}</small></div><div className={css.accountActions}>{account.reauthRequired === true || account.apiKeyConfigured || agnesCreateApiKey === undefined ? null : <button className={`${css.button} ${css.buttonPrimary}`} type="button" onClick={() => { createAgnesKey(account.id) }} disabled={agnesCreateBusy}>{agnesCreateBusy ? '创建中…' : '创建 Key'}</button>}<button className={css.button} type="button" onClick={() => { refreshAgnes(account.id) }}>刷新</button><button className={`${css.button} ${css.buttonDanger}`} type="button" onClick={() => { removeAgnes(account.id) }}>移除</button></div></div>)}</div> : null}
            {agnesResetOpen ? <div className={css.authForm}><small className={`${css.sectionMeta} ${css.authFull}`}>如果该账号通过第三方方式创建，Agnes 可能不提供密码重置。</small><input className={css.input} type="email" value={agnesResetEmail} onChange={(event) => { setAgnesResetEmail(event.target.value) }} placeholder="找回密码邮箱" /><input className={css.input} type="password" value={agnesResetPasswordValue} onChange={(event) => { setAgnesResetPasswordValue(event.target.value) }} placeholder="新密码" /><input className={css.input} type="password" value={agnesResetConfirm} onChange={(event) => { setAgnesResetConfirm(event.target.value) }} placeholder="确认新密码" /><input className={css.input} value={agnesResetCode} onChange={(event) => { setAgnesResetCode(event.target.value) }} placeholder="找回密码验证码" /><div className={css.accountActions}><button className={css.button} type="button" onClick={sendAgnesResetCode} disabled={agnesResetCooldown > 0}>{agnesResetCooldown > 0 ? `${agnesResetCooldown}s 后重发` : '发送验证码'}</button><button className={`${css.button} ${css.buttonPrimary}`} type="button" onClick={resetAgnesPassword}>重置密码</button><button className={css.button} type="button" onClick={() => { setAgnesResetOpen(false) }}>返回登录</button></div></div> : <div className={css.authForm}><input className={css.input} type="email" value={agnesEmail} onChange={(event) => { setAgnesEmail(event.target.value) }} placeholder="Agnes 邮箱" /><input className={css.input} type="password" value={agnesPassword} onChange={(event) => { setAgnesPassword(event.target.value) }} placeholder="密码" /><input className={css.input} value={agnesCode} onChange={(event) => { setAgnesCode(event.target.value) }} placeholder="注册验证码（注册时填写）" /><div className={css.accountActions}><button className={css.button} type="button" onClick={sendAgnesCode} disabled={agnesRegisterCooldown > 0}>{agnesRegisterCooldown > 0 ? `${agnesRegisterCooldown}s 后重发` : '发送验证码'}</button><button className={css.button} type="button" onClick={registerAgnes}>注册并创建 Key</button><button className={`${css.button} ${css.buttonPrimary}`} type="button" onClick={loginAgnes}>登录</button><button className={css.button} type="button" onClick={() => { setAgnesResetOpen(true) }}>忘记密码？</button></div></div>}
          </div> : null}
        </ProviderCard> : null}
        {settingsPage === 'providers' && clineStatus !== undefined ? <ProviderCard
          language={language}
          name="Cline" visibility={providerVisibility('cline')}
          title={language === 'zh' ? '官方免费模型与多账号轮询' : 'Official free models with account rotation'}
          icon={<ProviderGlyph kind="cline" />}
          status={{ label: state.cline?.status === 'authenticated' ? (language === 'zh' ? '已登录' : 'Signed in') : (language === 'zh' ? '未登录' : 'Signed out'), tone: state.cline?.status === 'authenticated' ? 'live' : 'idle' }}
          summary={state.cline?.status === 'authenticated'
            ? language === 'zh'
              ? `已登录 ${state.cline.accounts.length} 个账号 · ${clineModelNames.length} 个免费模型${clinePoolBlocked ? (language === 'zh' ? ' · 有账号不可用' : ' · some accounts unavailable') : clinePoolDegraded ? (language === 'zh' ? ' · 部分模型额度已用完' : ' · some models out of budget') : ''}`
              : `${state.cline.accounts.length} accounts · ${clineModelNames.length} free models${clinePoolBlocked ? ' · some accounts unavailable' : clinePoolDegraded ? ' · some models out of budget' : ''}`
            : undefined}
          models={clineModelNames}
          description={state.cline?.status === 'authenticated'
            ? language === 'zh' ? '凭证仅保存在 Harness Host；账号自动轮询，每个模型的免费额度独立计算，某个模型用完后只停该模型，其他模型仍可用。' : 'Credentials stay in the Harness Host. Each free model has its own budget: when one runs out, only that model is parked and the rest keep serving.'
            : language === 'zh' ? '使用 Cline 账号授权，即可调用 Cline 官方免费模型；支持添加多个账号。' : 'Authorize with a Cline account to use Cline\u2019s official free models. Several accounts are supported.'}
          notice={clinePoolBlocked
            ? (language === 'zh' ? '部分账号处于限流或凭证失效状态，请在账号管理中查看详情。' : 'Some accounts are rate limited or need re-auth. See Manage accounts for details.')
            : clinePoolDegraded ? (language === 'zh' ? '部分模型的免费额度已用完（按模型计算），其他模型仍可使用；详情见账号管理。' : 'Some free models are out of budget (budgets are per model); the rest still work. See Manage accounts for details.') : undefined}
          actions={<>
            <button className={css.button} type="button" onClick={() => { setClinePanelOpen(open => !open) }} aria-expanded={clinePanelOpen}>{state.cline?.status === 'authenticated' ? (language === 'zh' ? `账号管理（${state.cline.accounts.length}）` : `Manage accounts (${state.cline.accounts.length})`) : (language === 'zh' ? '添加账号' : 'Add account')}</button>
            {state.cline?.status === 'authenticated' ? <button className={css.button} type="button" onClick={() => { refreshCline() }} disabled={clineBusy}>{clineBusy ? (language === 'zh' ? '刷新中…' : 'Refreshing…') : (language === 'zh' ? '刷新凭证' : 'Refresh credentials')}</button> : null}
            {state.cline?.status === 'authenticated' ? <button className={`${css.button} ${css.buttonDanger}`} type="button" onClick={logoutCline}>{language === 'zh' ? '退出全部' : 'Sign out all'}</button> : null}
          </>}
        >
          {clinePanelOpen ? <div className={css.poolManager}>
            {state.cline?.status === 'authenticated' ? <div className={css.poolList}>{state.cline.accounts.map(account => <PoolAccountCard
              key={account.id}
              monogram={poolMonogram(account.email ?? account.id)}
              name={account.email ?? account.id}
              note={clineAccountStatusLabel(account, language)}
              chips={clineAccountChips(account, language)}
            >
              <button className={css.button} type="button" onClick={() => { refreshCline(account.id) }} disabled={clineBusy}>{language === 'zh' ? '刷新' : 'Refresh'}</button>
              <button className={`${css.button} ${css.buttonDanger}`} type="button" onClick={() => { removeClineAccount(account.id) }}>{language === 'zh' ? '移除' : 'Remove'}</button>
            </PoolAccountCard>)}</div> : null}
            {state.cline?.status === 'authenticated' && state.cline.usage !== undefined && (state.cline.usage.windows.length > 0 || state.cline.usage.balanceUsd !== undefined || state.cline.usage.plan !== undefined) ? <div className={css.clineUsage}>
              {state.cline.usage.plan !== undefined || state.cline.usage.balanceUsd !== undefined ? <small className={css.clineUsageHead}>{[state.cline.usage.plan, state.cline.usage.balanceUsd !== undefined ? (language === 'zh' ? `余额 ${formatMoney(state.cline.usage.balanceUsd, 'USD')}` : `Balance ${formatMoney(state.cline.usage.balanceUsd, 'USD')}`) : undefined].filter(Boolean).join(' · ')}</small> : null}
              {state.cline.usage.windows.map((window) => {
                const percent = clineUsagePercent(window)
                return <div className={css.clineUsageRow} key={window.id}>
                  <small className={css.clineUsageLabel}>{clineUsageWindowLabel(window.id, language)}</small>
                  <div className={css.clineUsageMeter} role="img" aria-label={`${clineUsageWindowLabel(window.id, language)}${percent === undefined ? '' : ` ${percent}`}`}>
                    {percent === undefined ? null : <div className={`${css.clineUsageFill} ${window.usedPercent !== undefined && window.usedPercent >= 90 ? css.clineUsageFillHigh : ''}`} style={{ width: `${Math.min(100, Math.max(0, window.usedPercent ?? 0))}%` }} />}
                  </div>
                  <small className={css.clineUsageValue}>{percent ?? '—'}</small>
                </div>
              })}
            </div> : null}
            {clineTicket === undefined ? <div className={css.accountActions}>
              <button className={`${css.button} ${css.buttonPrimary}`} type="button" onClick={startClineLogin} disabled={clineBusy}>{clineBusy ? (language === 'zh' ? '正在打开浏览器…' : 'Opening browser…') : (language === 'zh' ? '使用 Cline 账号登录' : 'Sign in with Cline')}</button>
            </div> : <div className={css.authForm}>
              <small className={`${css.sectionMeta} ${css.authFull}`}>{language === 'zh' ? '已自动打开浏览器授权页面；若未打开，请点击下方链接完成授权，本页会自动检测并添加账号：' : 'Your browser should have opened the authorization page. If it did not, use the link below; this page detects the account automatically.'}</small>
              <a className={css.button} href={safeAuthorizationUrl(clineTicket.verificationUrl)} target="_blank" rel="noopener noreferrer">{language === 'zh' ? '打开授权页面' : 'Open authorization page'}</a>
              <strong className={`${css.accountName} ${css.authFull}`}>{clineTicket.userCode}</strong>
              <button className={css.button} type="button" onClick={() => { setClineTicket(undefined) }}>{language === 'zh' ? '取消' : 'Cancel'}</button>
            </div>}
            {clineAddAccount === undefined ? null : <details className={css.advisorManual}><summary>{language === 'zh' ? '用手上的 Cline refresh token 添加账号' : 'Add an account from a Cline refresh token'}</summary><small>{language === 'zh' ? '同一个账号重复添加会替换原有凭证；密码与令牌只保存在 Harness Host。' : 'Adding the same account again replaces its credential. The token stays in the Harness Host.'}</small><div className={css.capabilityForm}><label><span>Refresh token</span><input className={css.input} type="password" autoComplete="off" aria-label="Cline refresh token" value={clineToken} onChange={(event) => { setClineToken(event.target.value) }} /></label><button className={css.button} type="button" onClick={addClineAccount} disabled={clineBusy || clineToken.trim() === ''}>{clineBusy ? (language === 'zh' ? '添加中…' : 'Adding…') : (language === 'zh' ? '添加账号' : 'Add account')}</button></div></details>}
          </div> : null}
        </ProviderCard> : null}
        {settingsPage === 'providers' && workbuddyStatus !== undefined ? <ProviderCard
          language={language}
          name="WorkBuddy" visibility={providerVisibility('workbuddy')}
          title={language === 'zh' ? 'WorkBuddy 国际版免费模型与多账号' : 'WorkBuddy International free models with accounts'}
          icon={<ProviderGlyph kind="workbuddy" />}
          status={{ label: workbuddyAuthenticated ? (language === 'zh' ? '已登录' : 'Signed in') : (language === 'zh' ? '未登录' : 'Signed out'), tone: workbuddyAuthenticated ? 'live' : 'idle' }}
          summary={workbuddyAuthenticated
            ? [language === 'zh'
              ? `已登录 ${state.workbuddy?.accounts.length ?? 0} 个账号 · ${workbuddyModelNames.length} 个免费模型`
              : `${state.workbuddy?.accounts.length ?? 0} accounts · ${workbuddyModelNames.length} free models`,
            workbuddyCreditSummary]
              .filter((part): part is string => part !== undefined)
              .join(' · ')
            : undefined}
          models={workbuddyModelNames}
          description={workbuddyAuthenticated
            ? language === 'zh' ? '凭证仅保存在 Harness Host；积分按账号单独计算，额度快照与保活由 Host 自动维护。' : 'Credentials stay in the Harness Host. Credits are tracked per account, and the pool refreshes them on its own schedule.'
            : language === 'zh' ? '使用 WorkBuddy 国际版账号登录，即可调用其免费模型；支持添加多个账号。' : 'Sign in with a WorkBuddy International account to use its free models. Several accounts are supported.'}
          actions={<>
            {/* The referral code stays inside the button: it is the whole point of
              * the click, and printing it as text next to the button only invites
              * people to retype a URL we would then have to keep in sync. */}
            <a className={css.button} href="https://workbuddy.ai/invite?code=4DPQJNMC" target="_blank" rel="noopener noreferrer">{language === 'zh' ? '注册 WorkBuddy 账号（送 350 积分）' : 'Create a WorkBuddy account (350 credits)'}</a>
            {workbuddyTicket === undefined ? <button className={`${css.button} ${css.buttonPrimary}`} type="button" onClick={startWorkbuddyLogin} disabled={workbuddyBusy}>{workbuddyBusy ? (language === 'zh' ? '正在打开浏览器…' : 'Opening browser…') : (language === 'zh' ? '使用 WorkBuddy 账号登录' : 'Sign in with WorkBuddy')}</button>
              : null}
            {workbuddyAuthenticated ? <button className={css.button} type="button" onClick={() => { setWorkbuddyPanelOpen(open => !open) }} aria-expanded={workbuddyPanelOpen}>{language === 'zh' ? `账号管理（${state.workbuddy?.accounts.length ?? 0}）` : `Manage accounts (${state.workbuddy?.accounts.length ?? 0})`}</button> : null}
            {workbuddyAuthenticated ? <button className={`${css.button} ${css.buttonDanger}`} type="button" onClick={logoutWorkbuddy}>{language === 'zh' ? '退出全部' : 'Sign out all'}</button> : null}
          </>}
        >
          {workbuddyTicket !== undefined ? <div className={css.authForm}>
            <small className={`${css.sectionMeta} ${css.authFull}`}>{workbuddyTicket.note === 'BROWSER_OPEN_FAILED'
              ? language === 'zh' ? '未能自动打开浏览器，请手动点击下方链接完成 WorkBuddy 国际版登录；本页会自动检测并添加账号：' : 'The browser could not be opened automatically. Use the link below to sign in to WorkBuddy International; this page detects the account and adds it automatically:'
              : language === 'zh' ? '已打开浏览器授权页面，请登录 WorkBuddy 国际版账号；登录完成后本页会自动检测并添加账号：' : 'Your browser opened the authorization page. Sign in to your WorkBuddy International account; this page detects it and adds the account automatically.'}</small>
            <a className={css.button} href={safeAuthorizationUrl(workbuddyTicket.loginUrl)} target="_blank" rel="noopener noreferrer">{language === 'zh' ? '打开授权页面' : 'Open authorization page'}</a>
            <button className={css.button} type="button" onClick={() => { setWorkbuddyTicket(undefined) }}>{language === 'zh' ? '取消' : 'Cancel'}</button>
          </div> : null}
          {workbuddyPanelOpen ? <div className={css.poolManager}>
            <div className={css.poolToolbar}>
              <small className={css.poolToolbarNote}>{workbuddyPoolNote}</small>
              <div className={css.poolToolbarActions}>
                <button className={`${css.button} ${css.buttonPrimary}`} type="button" onClick={refreshWorkbuddyCredits} disabled={workbuddyBusy || workbuddyRefreshCredits === undefined}>{language === 'zh' ? '刷新额度' : 'Refresh credits'}</button>
              </div>
            </div>
            {workbuddyAuthenticated ? <div className={css.poolList}>{workbuddyAccounts.map((account) => {
              const credits = account.credits
              const label = account.email ?? account.id
              // A nearly spent account reads as pressure even when nothing is
              // expiring: the meter is the signal the user scans first.
              const remainingPercent = credits === undefined ? 100 : workbuddyCreditPercent(credits)
              const tone: PoolChipTone = credits?.expired === true || credits?.error !== undefined
                ? 'danger'
                : credits?.expiringSoon === true || remainingPercent < 20 ? 'warn' : 'live'
              const active = state.workbuddy?.activeAccountId === account.id
              return <PoolAccountCard
                key={account.id}
                monogram={poolMonogram(label)}
                name={label}
                note={workbuddyCreditLine(credits, language)}
                chips={active ? [{ label: language === 'zh' ? '当前使用' : 'in use', tone: 'live' as const }, ...workbuddyAccountChips(account, language)] : workbuddyAccountChips(account, language)}
                {...credits === undefined || credits.error !== undefined
                  ? {}
                  : { meter: { percent: workbuddyCreditPercent(credits), label: `${formatCredits(credits.remaining)} / ${formatCredits(credits.total)}`, tone } }}
              >
                {active || workbuddySetActiveAccount === undefined ? null : <button className={css.button} type="button" onClick={() => { useWorkbuddyAccount(account.id) }} disabled={workbuddyBusy}>{language === 'zh' ? '设为当前' : 'Use this account'}</button>}
                <button className={`${css.button} ${css.buttonDanger}`} type="button" onClick={() => { removeWorkbuddyAccount(account.id) }}>{language === 'zh' ? '移除' : 'Remove'}</button>
              </PoolAccountCard>
            })}</div> : null}
            <small className={css.poolFootnote}>{language === 'zh' ? '备用方式：登录 WorkBuddy 桌面应用后，点击「导入桌面端登录」可读取本机凭证。' : 'Fallback: after signing in to the WorkBuddy desktop app, Import desktop sign-in reads the local credential.'}</small>
            <div className={css.accountActions}>
              <button className={css.button} type="button" onClick={importWorkbuddyLogin} disabled={workbuddyBusy}>{workbuddyBusy ? (language === 'zh' ? '导入中…' : 'Importing…') : (language === 'zh' ? '导入桌面端登录' : 'Import desktop sign-in')}</button>
            </div>
          </div> : null}
        </ProviderCard> : null}
        {settingsPage === 'providers' && qoderStatus !== undefined ? <ProviderCard
          language={language}
          name="Qoder" visibility={providerVisibility('qoder')}
          title={language === 'zh' ? 'Qoder 免费模型与账号额度' : 'Qoder free model with account quota'}
          icon={<ProviderGlyph kind="qoder" />}
          status={{ label: qoderAuthenticated ? (language === 'zh' ? '已登录' : 'Signed in') : (language === 'zh' ? '未登录' : 'Signed out'), tone: qoderAuthenticated ? 'live' : 'idle' }}
          summary={qoderAuthenticated
            ? [language === 'zh'
              ? `已登录 ${qoderAccounts.length} 个账号 · ${qoderModelNames.length} 个免费模型`
              : `${qoderAccounts.length} accounts · ${qoderModelNames.length} free models`,
            qoderAccounts[0]?.quota === undefined ? undefined : qoderQuotaLine(qoderAccounts[0].quota)]
              .filter((part): part is string => part !== undefined)
              .join(' · ')
            : undefined}
          models={qoderModelNames}
          description={qoderAuthenticated
            ? language === 'zh' ? '凭证仅保存在 Harness Host；只展示免费的 Qwen 3.8 Flash 模型，额度按账号单独计算。' : 'Credentials stay in the Harness Host. Only the free Qwen 3.8 Flash route is shown, and quota is tracked per account.'
            : language === 'zh' ? '使用 Qoder 账号登录，即可调用其免费模型（Qwen 3.8 Flash）。' : 'Sign in with a Qoder account to use its free model (Qwen 3.8 Flash).'}
          actions={<>
            {qoderTicket === undefined ? <button className={`${css.button} ${css.buttonPrimary}`} type="button" onClick={startQoderLogin} disabled={qoderBusy}>{qoderBusy ? (language === 'zh' ? '正在打开浏览器…' : 'Opening browser…') : (language === 'zh' ? '使用 Qoder 账号登录' : 'Sign in with Qoder')}</button> : null}
            {qoderAuthenticated && runQoderCheckin !== undefined ? <button className={css.button} type="button" onClick={claimQoderCredits} disabled={qoderCheckinBusy}>{qoderCheckinBusy ? (language === 'zh' ? '签到中…' : 'Checking in…') : (language === 'zh' ? '签到领积分' : 'Claim daily credits')}</button> : null}
            {qoderAuthenticated ? <button className={css.button} type="button" onClick={() => { setQoderPanelOpen(open => !open) }} aria-expanded={qoderPanelOpen}>{language === 'zh' ? `账号管理（${qoderAccounts.length}）` : `Manage accounts (${qoderAccounts.length})`}</button> : null}
            {qoderAuthenticated ? <button className={`${css.button} ${css.buttonDanger}`} type="button" onClick={logoutQoder}>{language === 'zh' ? '退出全部' : 'Sign out all'}</button> : null}
          </>}
        >
          {qoderCheckinReport === undefined ? null : <div className={css.poolToolbarNote} role="status">{checkinSummary(qoderCheckinReport, language)}</div>}
          {qoderTicket !== undefined ? <div className={css.authForm}>
            <small className={`${css.sectionMeta} ${css.authFull}`}>{qoderTicket.note === 'BROWSER_OPEN_FAILED'
              ? language === 'zh' ? '未能自动打开浏览器，请手动点击下方链接完成 Qoder 登录；本页会自动检测并添加账号：' : 'The browser could not be opened automatically. Use the link below to sign in to Qoder; this page detects the account and adds it automatically:'
              : language === 'zh' ? '已打开浏览器授权页面，请登录 Qoder 账号；登录完成后本页会自动检测并添加账号：' : 'Your browser opened the authorization page. Sign in to your Qoder account; this page detects it and adds the account automatically.'}</small>
            <a className={css.button} href={safeAuthorizationUrl(qoderTicket.loginUrl)} target="_blank" rel="noopener noreferrer">{language === 'zh' ? '打开授权页面' : 'Open authorization page'}</a>
            <button className={css.button} type="button" onClick={() => { setQoderTicket(undefined) }}>{language === 'zh' ? '取消' : 'Cancel'}</button>
          </div> : null}
          {qoderPanelOpen ? <div className={css.poolManager}>
            <div className={css.poolToolbar}>
              <small className={css.poolToolbarNote}>{language === 'zh' ? `已登录 ${qoderAccounts.length} 个账号 · 额度手动刷新` : `${qoderAccounts.length} accounts · refresh quota manually`}</small>
              <div className={css.poolToolbarActions}>
                <button className={`${css.button} ${css.buttonPrimary}`} type="button" onClick={refreshQoderQuota} disabled={qoderBusy || qoderRefreshQuota === undefined}>{language === 'zh' ? '刷新额度' : 'Refresh quota'}</button>
              </div>
            </div>
            {qoderAuthenticated ? <div className={css.poolList}>{qoderAccounts.map((account) => {
              const label = account.name ?? account.email ?? account.id
              const active = state.qoder?.activeAccountId === account.id
              const regionChip = { label: account.region === 'cn' ? (language === 'zh' ? '国内版' : 'China') : (language === 'zh' ? '国际版' : 'Global'), tone: 'idle' as const }
              return <PoolAccountCard
                key={account.id}
                monogram={poolMonogram(label)}
                name={label}
                note={account.quota === undefined ? (language === 'zh' ? '暂无额度数据' : 'No quota data') : qoderQuotaLine(account.quota)}
                chips={active ? [{ label: language === 'zh' ? '当前使用' : 'in use', tone: 'live' as const }, regionChip] : [regionChip]}
              >
                {active || qoderSetActiveAccount === undefined ? null : <button className={css.button} type="button" onClick={() => { useQoderAccount(account.id) }} disabled={qoderBusy}>{language === 'zh' ? '设为当前' : 'Use this account'}</button>}
                <button className={`${css.button} ${css.buttonDanger}`} type="button" onClick={() => { removeQoderAccount(account.id) }}>{language === 'zh' ? '移除' : 'Remove'}</button>
              </PoolAccountCard>
            })}</div> : null}
          </div> : null}
        </ProviderCard> : null}
        {settingsPage === 'providers' && traeStatus !== undefined ? <ProviderCard
          language={language}
          name="Trae" visibility={providerVisibility('trae')}
          title={language === 'zh' ? 'Trae 账号与模型' : 'Trae account and models'}
          icon={<ProviderGlyph kind="trae" />}
          status={{
            label: traePending ? (language === 'zh' ? '授权中' : 'Authorizing') : traeAuthenticated ? (language === 'zh' ? '已登录' : 'Signed in') : (language === 'zh' ? '未登录' : 'Signed out'),
            tone: traePending ? 'warn' : traeAuthenticated ? 'live' : 'idle' }}
          summary={traeAuthenticated
            ? [language === 'zh'
              // Both realms are named once the pool holds one of each: "3 accounts"
              // on a mixed pool hides the fact that a model belongs to only one of
              // them, which is the thing the user has to know to pick a model.
              ? (traeCnCount > 0 && traeGlobalCount > 0
                ? `已登录 ${traeAccounts.length} 个账号（国内 ${traeCnCount} · 国际 ${traeGlobalCount}）`
                : `已登录 ${traeAccounts.length} 个账号`)
              : `${traeAccounts.length} accounts`,
            traeModels.length === 0 ? undefined : language === 'zh' ? `${traeModels.length} 个可用模型` : `${traeModels.length} models`]
              .filter((part): part is string => part !== undefined)
              .join(' · ')
            : undefined}
          models={traeModels.map(model => model.name)}
          description={traeAuthenticated
            ? language === 'zh' ? '凭证仅保存在 Harness Host，转换为 Harness 可直接调用的 API；会话过期时重新登录即可。' : 'Credentials stay in the Harness Host and are exposed as an API the Harness can call directly. Sign in again when a session expires.'
            : language === 'zh' ? '使用 Trae 账号登录，即可在 Harness 中调用 Trae 模型。' : 'Sign in with a Trae account to call Trae models from the Harness.'}
          actions={<>
            {traePending ? null : <button className={`${css.button} ${css.buttonPrimary}`} type="button" onClick={() => { startTraeLogin('cn') }} disabled={traeBusy || traeStartBrowserLogin === undefined}>{traeBusy ? (language === 'zh' ? '正在打开浏览器…' : 'Opening browser…') : (language === 'zh' ? '登录国内版账号' : 'Sign in (China)')}</button>}
            {traePending ? null : <button className={css.button} type="button" onClick={() => { startTraeLogin('sg') }} disabled={traeBusy || traeStartBrowserLogin === undefined}>{language === 'zh' ? '登录国际版账号' : 'Sign in (Global)'}</button>}
            {traePending ? <button className={css.button} type="button" onClick={cancelTraeLogin} disabled={traeBusy}>{language === 'zh' ? '取消授权' : 'Cancel'}</button> : null}
            {traeAuthenticated && runTraeCheckin !== undefined ? <button className={css.button} type="button" onClick={claimTraeCredits} disabled={traeCheckinBusy}>{traeCheckinBusy ? (language === 'zh' ? '签到中…' : 'Checking in…') : (language === 'zh' ? '签到领积分' : 'Claim daily credits')}</button> : null}
            {traeAuthenticated ? <button className={css.button} type="button" onClick={() => { setTraePanelOpen(open => !open) }} aria-expanded={traePanelOpen}>{language === 'zh' ? `账号管理（${traeAccounts.length}）` : `Manage accounts (${traeAccounts.length})`}</button> : null}
            {traeAuthenticated ? <button className={`${css.button} ${css.buttonDanger}`} type="button" onClick={logoutTrae}>{language === 'zh' ? '退出全部' : 'Sign out all'}</button> : null}
          </>}
        >
          {traeCheckinReport === undefined ? null : <div className={css.poolToolbarNote} role="status">{checkinSummary(traeCheckinReport, language)}</div>}
          {traePending ? <div className={css.authForm}>
            <small className={`${css.sectionMeta} ${css.authFull}`}>{traeLoginPending?.note === 'BROWSER_OPEN_FAILED'
              ? language === 'zh' ? `未能自动打开浏览器，请手动打开授权页面完成${traeRealmName(traeLoginPending.realm, language)} Trae 登录。` : `The browser could not be opened automatically. Open the authorization page yourself to sign in to ${traeRealmName(traeLoginPending.realm, language)} Trae.`
              : language === 'zh' ? `已打开浏览器授权页面，请登录${traeRealmName(traeLoginPending.realm, language)} Trae 账号；登录完成后本页会自动检测并添加账号。` : `Your browser opened the authorization page. Sign in to ${traeRealmName(traeLoginPending.realm, language)} Trae; this page detects the account and adds it automatically.`}</small>
            {traeLoginPending?.loginUrl === undefined ? null : <a className={css.button} href={safeAuthorizationUrl(traeLoginPending.loginUrl)} target="_blank" rel="noopener noreferrer">{language === 'zh' ? '打开授权页面' : 'Open authorization page'}</a>}
            <label className={`${css.selectCell} ${css.authFull}`}>
              <small className={css.cellLabel}>{language === 'zh' ? '若浏览器没有自动跳回本机，请把登录后最终跳转的地址粘贴到这里（回调链接也可以）' : 'If the browser does not return to this machine, paste the final address it landed on (a callback URL works too)'}</small>
              <input className={css.input} value={traeCallback} onChange={(event) => { setTraeCallback(event.target.value) }} placeholder="http://127.0.0.1:port/callback?code=…" aria-label={language === 'zh' ? 'Trae 回调链接' : 'Trae callback URL'} spellCheck={false} />
            </label>
            <button className={css.button} type="button" onClick={submitTraeCallback} disabled={traeBusy || traeCallback.trim() === ''}>{language === 'zh' ? '提交回调链接' : 'Submit callback URL'}</button>
          </div> : null}
          {traePanelOpen ? <div className={css.poolManager}>
            <div className={css.poolToolbar}>
              <small className={css.poolToolbarNote}>{language === 'zh' ? `已登录 ${traeAccounts.length} 个账号 · 应用内选择当前使用账号` : `${traeAccounts.length} accounts · choose the account in use here`}</small>
            </div>
            {traeAuthenticated ? <div className={css.poolList}>{traeAccounts.map((account) => {
              const active = state.trae?.status === 'authenticated' && state.trae.accountId === account.id
              const needsLogin = account.status === 'reauth-required'
              const expiry = account.expiresAt === undefined ? undefined : `${language === 'zh' ? '有效期至' : 'Expires'} ${new Date(account.expiresAt).toISOString().slice(0, 10)}`
              return <PoolAccountCard
                key={account.id}
                monogram={poolMonogram(account.label)}
                name={account.label}
                note={needsLogin
                  ? language === 'zh' ? '会话已过期，请重新登录' : 'Session expired — sign in again'
                  : expiry ?? (language === 'zh' ? '会话有效' : 'Session active')}
                chips={[
                  { label: traeRealmName(account.realm, language), tone: 'idle' as const },
                  ...(active ? [{ label: language === 'zh' ? '当前使用' : 'in use', tone: 'live' as const }] : []),
                  ...(needsLogin ? [{ label: language === 'zh' ? '需重新登录' : 'reauth', tone: 'warn' as const }] : []),
                ]}
              >
                {active || traeSetActiveAccount === undefined || needsLogin ? null : <button className={css.button} type="button" onClick={() => { runTraeAction(() => traeSetActiveAccount(account.id)) }} disabled={traeBusy}>{language === 'zh' ? '设为当前' : 'Use this account'}</button>}
                <button className={`${css.button} ${css.buttonDanger}`} type="button" onClick={() => { if (traeRemoveAccount !== undefined) runTraeAction(() => traeRemoveAccount(account.id)) }}>{language === 'zh' ? '移除' : 'Remove'}</button>
              </PoolAccountCard>
            })}</div> : null}
          </div> : null}
        </ProviderCard> : null}
        {settingsPage === 'overview' ? <section className={css.section}>
          <div className={css.sectionHeader}><div><div className={css.kicker}>{t('account')}</div><strong className={css.sectionName}>{state.account.status === 'loading' ? (language === 'zh' ? '正在读取账户状态' : 'Reading account state') : state.account.status === 'authenticated' ? t('connectedAccount') : t('notSignedIn')}</strong></div><span className={`${css.badge} ${state.account.status === 'authenticated' ? css.badgeLive : ''}`}>{state.account.status === 'loading' ? (language === 'zh' ? '读取中' : 'Reading') : state.account.status === 'authenticated' ? t('live') : t('signedOut')}</span></div>
          {state.account.status === 'backend-not-configured' ? <small className={css.sectionMeta}>{t('backendNotConfigured')}</small> : null}
          {state.account.status === 'restoring' || state.account.status === 'loading' ? <div className={css.infoCell}><strong>{state.account.status === 'loading' ? '正在读取账户状态' : '正在恢复本机登录'}</strong><small>{state.account.status === 'loading' ? 'Host 正在读取本机保存的登录凭证与账户信息；读取完成后这里会直接显示账号，不需要重新输入密码。' : '已找到本机保存的会话凭证，正在后台恢复账户信息。网络恢复后会自动完成，不需要重新输入密码。'}</small></div> : null}
          {state.account.status === 'authenticated' ? <><div className={css.accountRow}><div className={css.accountIdentityWithAvatar}><AccountAvatar email={state.account.user?.email ?? ''} {...state.account.user?.avatarUrl === undefined ? {} : { avatarUrl: state.account.user.avatarUrl }} language={language} /><div className={css.accountText}><strong className={css.accountName}>{state.account.user?.email}</strong><small className={css.accountEmail}>{accountProviderLabel(state.account.user?.email ?? '', language)}</small></div></div><div className={css.accountActions}><span className={css.balance}><small className={css.balanceLabel}>{t('balance')}</small>{formatMoney(state.account.user?.balance, 'USD')}</span><button className={css.button} type="button" onClick={submitLogout}>{t('logout')}</button></div></div><DeviceSessionManager {...deviceSessions === undefined ? {} : { load: deviceSessions }} {...revokeDeviceSession === undefined ? {} : { revoke: revokeDeviceSession }} {...revokeAllSessions === undefined ? {} : { revokeAll: revokeAllSessions }} language={language} {...accountDetail === undefined ? {} : { extraActions: <>
            {/* Beside the raw-account read, and named for what it produces: this
                downloads documents, where that button dumps the account payload. */}
            {paymentOrders === undefined || paymentReceiptDocument === undefined ? null : <button className={css.button} type="button" aria-expanded={receiptsOpen} onClick={() => { setReceiptsOpen(previous => !previous) }}>{receiptsOpen ? (language === 'zh' ? '收起收据' : 'Hide receipts') : (language === 'zh' ? '下载收据' : 'Download receipts')}</button>}
            <button className={css.button} type="button" onClick={showDiagnostics} disabled={diagnosticsBusy}>{diagnosticsBusy ? (language === 'zh' ? '读取中…' : 'Reading…') : (language === 'zh' ? '读取原始数据' : 'Read raw data')}</button>
          </> }} />{receiptsOpen && paymentOrders !== undefined && paymentReceiptDocument !== undefined ? <PaymentReceiptManager orders={paymentOrders} receiptDocument={paymentReceiptDocument} {...paymentStripeReceiptDocument === undefined ? {} : { stripeReceiptDocument: paymentStripeReceiptDocument }} language={language} /> : null}{diagnostics === undefined ? null : <pre className={css.diagnosticsDump}>{JSON.stringify(diagnostics, null, 2)}</pre>}</> : state.account.status === 'restoring' || state.account.status === 'loading' ? null :          <div className={css.authLayout}>
            {/* One card across the whole row. A second column of marketing copy used
              to sit beside the form; it left the sign-in half empty on wide panels
              and said nothing the form itself does not. The card now fills the
              layer, and the fields inside are laid out two-up so the width is
              used instead of stretched. */}
            <div className={css.authPanel}>
              <div className={css.authHead}>
                <strong className={css.authTitle}>{language === 'zh' ? '登录 FreeCodeGo' : 'Sign in to FreeCodeGo'}</strong>
                <small className={css.authSubtitle}>{language === 'zh' ? '同步余额、模型路由与本机会话，登录后即可调度全部已授权模型。' : 'Sync balance, model routing, and the local session to run every authorized model.'}</small>
              </div>
              {register === undefined || state.account.status === 'mfa-required' ? null : <div className={css.authTabs} role="tablist" aria-label={language === 'zh' ? '登录或注册' : 'Sign in or register'}>
                <button className={`${css.authTab} ${authTab === 'login' ? css.authTabActive : ''}`} type="button" role="tab" aria-selected={authTab === 'login'} onClick={() => { setAuthTab('login'); setAuthNotice(undefined) }}>{t('login')}</button>
                <button className={`${css.authTab} ${authTab === 'register' ? css.authTabActive : ''}`} type="button" role="tab" aria-selected={authTab === 'register'} onClick={() => { setAuthTab('register'); setAuthNotice(undefined) }}>{t('register')}</button>
              </div>}
              <div className={css.authSocialRow}>
                <button className={css.authSocialButton} type="button" onClick={() => { submitOAuth('google') }} disabled={oauthBusy !== undefined} aria-busy={oauthBusy === 'google'}><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.57 5.57 0 0 1-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82Z"/><path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A11.99 11.99 0 0 0 12 24Z"/><path fill="#FBBC05" d="M5.27 14.29A7.2 7.2 0 0 1 4.89 12c0-.8.14-1.57.38-2.29V6.62H1.29a12 12 0 0 0 0 10.76l3.98-3.09Z"/><path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.69 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75Z"/></svg><span>Google</span></button>
                <button className={css.authSocialButton} type="button" onClick={() => { submitOAuth('github') }} disabled={oauthBusy !== undefined} aria-busy={oauthBusy === 'github'}><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .3a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.03c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5 1 .1-.78.42-1.31.76-1.61-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.11-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.01 0c2.29-1.55 3.3-1.23 3.3-1.23.65 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.81 5.63-5.49 5.92.43.38.82 1.11.82 2.24v3.32c0 .32.21.7.82.58A12 12 0 0 0 12 .3Z"/></svg><span>GitHub</span></button>
              </div>
              {oauthPending === undefined ? null : <form className={css.authForm} onSubmit={(event) => { event.preventDefault(); submitOAuthPending() }}>
                <small className={`${css.authStep} ${css.authFull}`}>{language === 'zh' ? `第三方登录待完成${oauthPending.email === undefined ? '' : `：${oauthPending.email}`}` : `Finish federated sign-in${oauthPending.email === undefined ? '' : `: ${oauthPending.email}`}`}</small>
                <div className={`${css.authTabs} ${css.authFull}`} role="tablist" aria-label={language === 'zh' ? '绑定或注册' : 'Bind or create'}>
                  {oauthPending.step !== 'email-completion' ? <button className={`${css.authTab} ${oauthPendingMode === 'bind' ? css.authTabActive : ''}`} type="button" role="tab" aria-selected={oauthPendingMode === 'bind'} onClick={() => { setOauthPendingMode('bind') }}>{language === 'zh' ? '绑定已有账号' : 'Bind existing'}</button> : null}
                  {oauthPending.step !== 'bind-login' ? <button className={`${css.authTab} ${oauthPendingMode === 'create' ? css.authTabActive : ''}`} type="button" role="tab" aria-selected={oauthPendingMode === 'create'} onClick={() => { setOauthPendingMode('create') }}>{language === 'zh' ? '注册新账号' : 'Create account'}</button> : null}
                </div>
                <input className={css.input} type="email" value={oauthPendingEmail} onChange={(event) => { setOauthPendingEmail(event.target.value) }} placeholder={t('email')} autoComplete="email" />
                <input className={css.input} type="password" value={oauthPendingPassword} onChange={(event) => { setOauthPendingPassword(event.target.value) }} placeholder={t('password')} autoComplete={oauthPendingMode === 'bind' ? 'current-password' : 'new-password'} />
                {oauthPendingMode === 'bind' ? <input className={css.input} value={oauthPendingTotpCode} onChange={(event) => { setOauthPendingTotpCode(event.target.value) }} placeholder={t('totpCode')} autoComplete="one-time-code" /> : null}
                {oauthPendingMode === 'create' ? <>
                  <div className={`${css.verifyRow} ${css.authFull}`}>
                    <input className={css.input} value={oauthPendingVerifyCode} onChange={(event) => { setOauthPendingVerifyCode(event.target.value) }} placeholder={t('verifyCode')} autoComplete="one-time-code" />
                    <button className={css.button} type="button" disabled={oauthPendingBusy || oauthPendingVerifyCooldown > 0 || oauthPendingSendVerifyCode === undefined || oauthPendingEmail.trim() === ''} onClick={submitOAuthPendingVerifyCode}>{oauthPendingVerifyCooldown > 0 ? `${oauthPendingVerifyCooldown}s` : t('sendVerifyCode')}</button>
                  </div>
                  {oauthPending.invitationRequired ? <input className={`${css.input} ${css.authFull}`} value={oauthPendingInvitation} onChange={(event) => { setOauthPendingInvitation(event.target.value) }} placeholder={language === 'zh' ? '邀请码' : 'Invitation code'} /> : null}
                </> : null}
                <button className={`${css.authSubmit} ${css.authFull}`} type="submit" disabled={oauthPendingBusy || oauthPendingEmail.trim() === '' || oauthPendingPassword === ''}>{oauthPendingBusy ? (language === 'zh' ? '提交中…' : 'Submitting…') : language === 'zh' ? '完成登录' : 'Finish sign-in'}</button>
                <button className={`${css.authTab} ${css.authFull}`} type="button" onClick={() => { setOauthPending(undefined) }}>{language === 'zh' ? '取消本次第三方登录' : 'Cancel this sign-in'}</button>
              </form>}
              <div className={css.authDivider} aria-hidden="true"><span>{language === 'zh' ? '或使用邮箱' : 'or sign in with email'}</span></div>
              {oauthNotice === undefined ? null : <small className={css.authNotice} role="status">{oauthNotice}</small>}
              {/* The card's own failure line. It sits between the divider and the
                  form so it is on screen with the button that produced it; the
                  panel-wide `actionError` is far above this card by the time the
                  reader is typing a code. */}
              {authNotice === undefined ? null : <div className={css.authNoticeAlert} role="alert"><span>{authNotice}</span><button className={css.button} type="button" onClick={() => { setAuthNotice(undefined) }}>{language === 'zh' ? '知道了' : 'Dismiss'}</button></div>}
              {state.account.status === 'mfa-required' ? <form className={css.authStack} onSubmit={submitMfaCode}>
                <small className={css.authStep}>{t('mfa')}{state.account.emailMasked === undefined ? '' : ` ${state.account.emailMasked}`}</small>
                <input className={css.input} value={totpCode} onChange={(event) => { setTotpCode(event.target.value) }} placeholder={t('totpCode')} autoComplete="one-time-code" />
                <button className={css.authSubmit} type="submit">{t('completeMfa')}</button>
              </form> : authTab === 'register' && register !== undefined ? <form className={css.authForm} onSubmit={submitRegistration}>
                <input className={css.input} type="email" required value={email} onChange={(event) => { setEmail(event.target.value) }} placeholder={t('email')} autoComplete="email" />
                <div className={css.authCodeRow}>
                  <input className={css.input} value={verifyCode} onChange={(event) => { setVerifyCode(event.target.value) }} placeholder={t('verifyCode')} autoComplete="one-time-code" />
                  {sendVerifyCode === undefined ? null : <button className={css.authCodeSend} type="button" disabled={verifySending || verifyCooldown > 0} onClick={sendAccountVerifyCode}>{verifyCooldown > 0 ? `${verifyCooldown}s` : verifySending ? (language === 'zh' ? '发送中…' : 'Sending…') : t('sendVerifyCode')}</button>}
                </div>
                <input className={`${css.input} ${css.authFull}`} type="password" required value={password} onChange={(event) => { setPassword(event.target.value) }} placeholder={t('password')} autoComplete="new-password" />
                <button className={`${css.authSubmit} ${css.authFull}`} type="submit" disabled={authBusy !== undefined} aria-busy={authBusy === 'register'}>{authBusy === 'register' ? (language === 'zh' ? '注册中…' : 'Creating account…') : language === 'zh' ? '注册并登录' : 'Create account'}</button>
                <small className={`${css.authNote} ${css.authFull}`}>{language === 'zh' ? '注册成功后本机自动登录，免费账号即可调度全部免费模型。' : 'A free account signs in automatically and can run every free model.'}</small>
              </form> : resetOpen && forgotPassword !== undefined && resetPassword !== undefined ? <form className={css.authForm} onSubmit={submitResetPassword}>
                {/* Recovery is its own form, reached from the sign-in form, because
                    it exists for the case where signing in could not work. The
                    address is shared with the card, so it is the one that was just
                    rejected. */}
                <input className={css.input} type="email" required value={email} onChange={(event) => { setEmail(event.target.value) }} placeholder={t('email')} autoComplete="email" />
                <div className={css.authCodeRow}>
                  <input className={css.input} value={resetCode} onChange={(event) => { setResetCode(event.target.value) }} placeholder={language === 'zh' ? '重置验证码' : 'Reset code'} autoComplete="one-time-code" />
                  <button className={css.authCodeSend} type="button" disabled={resetSending || resetCooldown > 0} onClick={sendResetCode}>{resetCooldown > 0 ? `${resetCooldown}s` : resetSending ? (language === 'zh' ? '发送中…' : 'Sending…') : (language === 'zh' ? '发送重置码' : 'Send code')}</button>
                </div>
                <input className={`${css.input} ${css.authFull}`} type="password" required minLength={6} value={resetSecret} onChange={(event) => { setResetSecret(event.target.value) }} placeholder={language === 'zh' ? '新密码（至少 6 位）' : 'New password (6+ characters)'} autoComplete="new-password" />
                <button className={`${css.authSubmit} ${css.authFull}`} type="submit" disabled={resetBusy || resetSecret === ''} aria-busy={resetBusy}>{resetBusy ? (language === 'zh' ? '重置中…' : 'Resetting…') : (language === 'zh' ? '重置密码' : 'Reset password')}</button>
                <button className={`${css.authTab} ${css.authFull}`} type="button" onClick={() => { setResetOpen(false); setAuthNotice(undefined) }}>{language === 'zh' ? '返回登录' : 'Back to sign-in'}</button>
                <small className={`${css.authNote} ${css.authFull}`}>{language === 'zh' ? '重置验证码与注册验证码不是同一个：注册码只发给未注册的邮箱，已注册的账号请用这里的「发送重置码」。' : 'The reset code is not the registration code: the registration channel refuses an address that already has an account, which is what this one is for.'}</small>
              </form> : <form className={css.authForm} onSubmit={submitLogin}>
                <input className={css.input} type="email" required value={email} onChange={(event) => { setEmail(event.target.value) }} placeholder={t('email')} autoComplete="email" />
                {/* The wrapper is the grid item, so the reveal control lives inside
                    the field instead of adding a third column to the row. */}
                <div className={css.passwordField}>
                  <input className={css.input} type={passwordVisible ? 'text' : 'password'} required value={password} onChange={(event) => { setPassword(event.target.value) }} placeholder={t('password')} autoComplete="current-password" />
                  <button className={css.passwordToggle} type="button" aria-pressed={passwordVisible} aria-label={language === 'zh' ? (passwordVisible ? '隐藏密码' : '显示密码') : (passwordVisible ? 'Hide password' : 'Show password')} onClick={() => { setPasswordVisible(visible => !visible) }}>{language === 'zh' ? (passwordVisible ? '隐藏' : '显示') : (passwordVisible ? 'Hide' : 'Show')}</button>
                </div>
                <div className={`${css.rememberRow} ${css.authFull}`}>
                  <label className={css.remember}><input type="checkbox" checked={rememberLogin} onChange={(event) => { setRememberLogin(event.target.checked) }} />{t('rememberLogin')}</label>
                  <label className={css.remember}><input type="checkbox" checked={rememberPassword} onChange={(event) => { setRememberPassword(event.target.checked) }} />{language === 'zh' ? '记住密码（下次自动填写）' : 'Remember the password (fill it in next time)'}</label>
                </div>
                <button className={`${css.authSubmit} ${css.authFull}`} type="submit" disabled={authBusy !== undefined} aria-busy={authBusy === 'login'}>{authBusy === 'login' ? (language === 'zh' ? '登录中…' : 'Signing in…') : t('login')}</button>
                {forgotPassword === undefined || resetPassword === undefined ? null : <button className={`${css.authTab} ${css.authFull}`} type="button" onClick={() => { setResetOpen(true); setAuthNotice(undefined) }}>{language === 'zh' ? '忘记密码？' : 'Forgot your password?'}</button>}
                <small className={`${css.authNote} ${css.authFull}`}>{language === 'zh' ? '勾选「保持登录状态」：登录会话保存在本机，重启后自动恢复；取消则退出程序即登出。勾选「记住密码」：密码存进本机凭据文件（仅当前系统用户可读，不加密），下次自动填写；取消勾选并登录、或退出登录，都会删掉它。' : 'Checked "Keep me signed in" stores the session on this machine and restores it after a restart; unchecked, closing the app signs you out. Checked "Remember the password" stores the password in the local credential file (readable by the current OS user only, not encrypted) and fills it in next time; signing in with it unchecked, or signing out, deletes it.'}</small>
              </form>}
            </div>
          </div>}
        </section> : null}
        {settingsPage === 'overview' ? <section className={css.section}>
          <div className={css.sectionHeader}><div><div className={css.kicker}>{t('plans')}</div><strong className={css.sectionName}>{t('subscriptionTitle')}</strong></div><span className={css.sectionMeta}>{state.account.status === 'loading' ? (language === 'zh' ? '正在读取账户状态…' : 'Reading account state…') : state.account.user === undefined ? t('backendRequired') : `${t('balance')}: ${formatMoney(state.account.user.balance, 'USD')}`}</span></div>
          <div className={css.paymentBar}><div><strong className={css.paymentHeading}>{language === 'zh' ? '充值额度' : 'Add credit'}</strong><small className={css.sectionMeta}>{language === 'zh' ? '额度长期有效，按实际使用量扣除。' : 'Credit stays valid and is charged by actual usage.'}</small></div>{/* The picker and the method chips are what the payer chooses with, so they are one
            right-aligned column; the channel's own sentence — limits, fees, rate and the
            receipt promise — is a full-width line under both. It used to be a third item
            in that row, which is what deformed the bar: sharing the row pushed the select
            down to its minimum width and clipped the selected option, and left the
            two-character label with nothing to do but wrap one character per line. */}{state.channels.length > 0 ? <div className={css.paymentPicker}><label className={css.paymentMethod}><span>{t('paymentMethod')}</span><select className={css.select} value={selectedPaymentType} onChange={(event) => { setPaymentType(event.target.value) }}>{state.channels.map(channel => <option key={channel.paymentType} value={channel.paymentType}>{paymentChannelLabel(channel.paymentType, language)}{channel.currency === undefined ? '' : ` (${channel.currency})`}</option>)}</select></label>{isCardChannel(selectedPaymentType) ? <div className={css.paymentMethods} aria-label={language === 'zh' ? '该支付方式支持' : 'Accepted by this method'}>{CARD_CHANNEL_METHODS.map(method => <span className={css.paymentMethodChip} key={method}>{method}</span>)}</div> : null}</div> : null}{state.channels.length > 0 ? <small className={css.paymentBarDetail}>{selectedChannelDescription(state.channels.find(channel => channel.paymentType === selectedPaymentType), language, state.paymentConfig)}</small> : null}</div>
          {state.pendingOrders !== undefined && state.pendingOrders.length > 0 ? <div className={css.pending}><strong className={css.pendingTitle}>{t('pendingOrders')}</strong><small className={css.pendingHint}>{t('pendingOrdersHint')}</small>{state.pendingOrders.map(order => <div className={css.pendingRow} key={order.orderId}><span className={css.pendingText}>{order.orderId} · 到账 {formatMoney(order.amount, 'USD')} · 支付 {formatMoney(order.payAmount ?? order.amount, orderSettlementCurrency(order, state.channels))} · {order.state}</span><button className={`${css.button} ${css.buttonDanger}`} type="button" onClick={() => { cancelPendingOrder(order) }} disabled={paymentCancel === undefined || !canCancelPaymentOrder(order)}>{t('cancelOrder')}</button></div>)}</div> : null}
          {state.account.status === 'restoring' || state.account.status === 'loading' ? <div className={css.sectionMeta} role="status">{state.account.status === 'loading' ? (language === 'zh' ? '正在读取账户状态…' : 'Reading account state…') : (language === 'zh' ? '正在恢复登录…' : 'Recovering session…')}</div> : state.plans.length === 0 ? <div className={css.sectionMeta}>{t('noPlans')}</div> : <>
            <div className={css.plans}>{saleablePlans.map((plan, index) => {
            // The second tier is the panel's recommendation. The backend sends
            // no "recommended" flag of its own, so this positional rule is the
            // whole contract and the badge has to keep following it.
              const featured = index === 1
              const discount = planDiscountPercent(plan)
              // Only this tier's own bullets: the lines every tier shares are stated
              // once under the grid, which is what turns six look-alike cards into a
              // comparable ladder.
              const bullets = planNotes.own.get(String(plan.id)) ?? []
              const description = plan.description === undefined ? undefined : localizePlanText(plan.description, plan.description, language === 'zh')
              const channel = state.channels.find(item => item.paymentType === selectedPaymentType)
              // What actually leaves the account, fees included — the same figure the
              // button commits to, shown next to the credit it buys so the ladder can
              // be compared without opening a checkout.
              const payable = plan.price === undefined || channel === undefined
                ? undefined
                : (() => { try { return paymentTotalForCredit(plan.price, channel) } catch { return undefined } })()
              // What every card can state about itself without inventing anything.
              // A tier card is the only place a buyer compares *offers*, so the
              // lines say what the credit buys, how it is drawn down, and how it
              // can be paid for — the questions a price alone does not answer. The
              // lines all tiers truly share stay in the strip under the grid, so
              // these deliberately avoid restating permanence or stacking.
              const perks = language === 'zh'
                ? [
                  '全部已授权模型通用：Claude、GPT、Gemini 与国产模型',
                  '按实际用量扣减，无月费、不自动续费、不用不扣',
                  '支持支付宝、微信支付与国际信用卡（Visa / Mastercard / Amex / JCB）',
                  '每笔充值与消费均可查，可随时下载收据留档',
                ]
                : [
                  'Runs every authorized model: Claude, GPT, Gemini and domestic models',
                  'Drawn down by actual usage — no monthly fee, no auto-renewal',
                  'Pay by Alipay, WeChat Pay, or an international card (Visa / Mastercard / Amex / JCB)',
                  'Every top-up and charge is recorded, with a downloadable receipt',
                ]
              // The offset shadow is a sibling element, so each tier is a shell that
              // owns the silhouette and an article that owns the content. Tests and
              // assistive tech keep seeing one `article` per tier.
              return <div className={css.planShell} key={String(plan.id)}>
                <article className={`${css.plan} ${featured ? css.planFeatured : ''}`}>
                  <div className={css.planTop}>
                    <span className={css.planDot} aria-hidden="true" />
                    <strong className={css.planName}>{localizePlanText(plan.name, plan.name, language === 'zh')}</strong>
                    {discount === undefined ? null : <small className={css.planSave}>{language === 'zh' ? `省 ${discount}%` : `-${discount}%`}</small>}
                    {featured ? <small className={css.planTag}>{t('recommended')}</small> : null}
                  </div>
                  {/* The offer sits in a pressed-in slot: what the credit is worth on
                    the left, what actually leaves the account on the right. */}
                  <div className={css.planRecess}>
                    <div className={css.planCreditBlock}>
                      <small className={css.planPriceLabel}><span className={css.planRecessCode} aria-hidden="true">Credit</span>{language === 'zh' ? '到账额度' : 'You get'}</small>
                      <div className={css.planPriceRow}>
                        <strong className={css.planPrice}>{formatMoney(plan.price, plan.currency)}</strong>
                        {/* The struck-through original rides on the same guard as the
                          badge: on its own a higher `originalPrice` that is not a
                          markdown (equal to, or below, the price) would print a
                          struck-through number that misstates the offer. */}
                        {discount === undefined ? null : <small className={css.planOriginalPrice}>{formatMoney(plan.originalPrice, plan.currency)}</small>}
                      </div>
                    </div>
                    {payable === undefined ? null : <div className={css.planPayBlock}>
                      <small className={css.planPayLabel}>{language === 'zh' ? '实付约合' : 'You pay'}</small>
                      <strong className={css.planPayable}>{formatMoney(payable, channel?.currency)}</strong>
                    </div>}
                  </div>
                  {/* The backend's own line, or what this ladder's credit is when it sends
                    none: every tier here is a permanent balance credit, and a card
                    with no second line reads as an unfinished one. */}
                  <div className={css.planBlurb}>
                    <small className={css.planPerk}>{description ?? (language === 'zh' ? '一次性充值，额度永久有效' : 'One-time top-up; the credit never expires')}</small>
                    <small className={css.planLead}>{language === 'zh'
                      ? '一次性充值，余额长期有效，不自动续费'
                      : 'One-time top-up; the balance does not expire and never auto-renews'}</small>
                  </div>
                  <div className={css.features}>{[...perks, ...bullets].map(feature => <span key={feature}><span className={css.planCheck} aria-hidden="true" /><span className={css.planFeatureText}>{feature}</span></span>)}</div>
                  <button className={`${css.button} ${css.buttonPrimary} ${css.planButton}`} type="button" disabled={checkoutPending || paymentCheckout === undefined || plan.price === undefined || plan.price <= 0 || selectedPaymentType === ''} onClick={() => { startCheckout(plan) }}>{checkoutPending ? t('processing') : formatCheckoutLabel(plan.price, channel, t('checkout'))}</button>
                  <div className={css.planFootnote}><span className={css.planDotOk} aria-hidden="true" /><span>{language === 'zh' ? '支付成功后额度自动到账' : 'Credit is applied as soon as the payment succeeds'}</span><small className={css.planBrandMark} aria-hidden="true">FreeCodeGo</small></div>
                </article>
              </div>
            })}</div>
            {planNotes.shared.length === 0 ? null : <div className={css.planShared}><small>{language === 'zh' ? '所有套餐' : 'Every tier'}</small>{planNotes.shared.map(note => <span key={note}><span className={css.planCheck} aria-hidden="true" />{note}</span>)}</div>}
          </>}
          {checkoutError === undefined ? null : <div className={css.paymentNotice} role="alert"><span>{checkoutError}</span><button className={css.button} type="button" onClick={() => { setCheckoutError(undefined) }}>{language === 'zh' ? '知道了' : 'Dismiss'}</button></div>}
          {state.order === undefined ? null : <div className={css.order}><strong className={css.orderTitle}>{t('order')}: {state.order.orderId} · {orderStateLabel(state.order.state, language === 'zh')}</strong><small className={css.sectionMeta}>到账 {formatMoney(state.order.amount, 'USD')} · 支付 {formatMoney(state.order.payAmount ?? state.order.amount, orderSettlementCurrency(state.order, state.channels))}</small><div className={css.orderActions}><button className={css.button} type="button" onClick={refreshOrder}>{t('refreshOrder')}</button><button className={css.button} type="button" onClick={verifyOrder} disabled={state.order.outTradeNo === undefined}>{t('verifyOrder')}</button>{canCancelPaymentOrder(state.order) ? <button className={`${css.button} ${css.buttonDanger}`} type="button" onClick={cancelOrder}>{t('cancelOrder')}</button> : null}{/* One predicate for both actions, and the same one the receipt list uses: the
                backend serves the document and the mail from one availability rule, so a
                button that refused while its neighbour offered the same document was the
                panel disagreeing with the backend — and with `recharging`, which is what an
                order settles into while its credits are still being applied, it refused for
                every order between paying and being credited. */}
                <button className={css.button} type="button" onClick={downloadCurrentOrderReceipt} disabled={paymentReceiptDocument === undefined || !orderReceiptAvailable(state.order)}>{language === 'zh' ? '下载收据' : 'Download receipt'}</button><button className={css.button} type="button" onClick={emailReceipt} disabled={paymentReceiptEmail === undefined || !orderReceiptAvailable(state.order)}>{t('emailReceipt')}</button>{/* Stripe's own document, on the same two conditions the receipt list uses:
                  only where the backend says Stripe holds one. It is drawn only then, so
                  there is nothing to disable — a button that could only report "not
                  available" is the panel inventing an option the payer does not have. */}{stripeReceiptOffered(state.order, paymentStripeReceiptDocument) ? <button className={css.button} type="button" onClick={downloadCurrentOrderStripeReceipt}>{language === 'zh' ? '下载付款凭证' : 'Download payment document'}</button> : null}</div><PaymentCheckoutLink value={state.order.checkoutUrl} label={t('openCheckout')} />{state.order.qrCode === undefined ? null : state.order.qrCode.startsWith('data:image/') ? <img className={css.qr} src={state.order.qrCode} alt={t('paymentQr')} /> : <PaymentQrCode value={state.order.qrCode} label={t('paymentQr')} language={language} />}{state.order.clientSecret === undefined ? null : <small className={css.sectionMeta}>{t('stripeSessionReady')}</small>}</div>}
          <GatewayPricingTable prices={state.gatewayPrices} error={state.gatewayPricingError} query={priceQuery} onQuery={setPriceQuery} language={language} />
        </section> : null}
      </div> : null}
      {/* Outside the `ready` gate on purpose. The payment surfaces live in this
          dialog now, and a panel that brushes a reload must not unmount a card
          form the customer is filling in. Everything it draws was snapshotted
          when it opened, so it needs nothing from `state`. */}
      {paymentDialog === undefined ? null : <PaymentDialog
        open
        order={paymentDialog.order}
        // The desktop payment config carries Stripe's publishable key. Without it
        // the dialog falls back to the QR or the provider page instead of
        // rendering a card form it could not initialise.
        publishableKey={paymentDialog.publishableKey}
        payCurrency={paymentDialog.payCurrency}
        language={language}
        returnUrl={`${FREECODEGO_WEB_BASE_URL}/payment/result`}
        {...paymentDialog.receiptEmail === undefined ? {} : { receiptEmail: paymentDialog.receiptEmail }}
        loadOrder={loadDialogOrder}
        onPaid={settleDialogPayment}
        {...paymentReceiptDocument === undefined ? {} : { onDownloadReceipt: () => { downloadReceipt(paymentDialog.order.orderId) } }}
        onCancelOrder={paymentCancel === undefined || !canCancelPaymentOrder(paymentDialog.order) ? undefined : cancelDialogOrder}
        onClose={() => { setPaymentDialog(undefined) }}
      />}
    </section>
  )
}

function PluginConflictProtection(input: {
  readonly status: Injected['pluginConflictStatus']
  readonly setEnabled: Injected['pluginConflictSetEnabled']
}): ReactNode {
  const [snapshot, setSnapshot] = useState<FreeCodeGoPluginConflictStatus | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const refresh = (): void => {
    if (input.status === undefined) return
    void input.status().then((result) => {
      if (result.ok) { setSnapshot(result.value); setLoadError(undefined); return }
      // A failed read leaves the authoritative value unknown. Recording it is
      // what keeps the switch from rendering as "on" while the badge says off.
      setLoadError(result.error.message)
    }).catch((reason: unknown) => { setLoadError(reason instanceof Error ? reason.message : String(reason)) })
  }
  useEffect(() => {
    refresh()
  }, [input.status])
  const update = (enabled: boolean): void => {
    if (input.setEnabled === undefined) return
    setLoadError(undefined)
    void input.setEnabled(enabled).then((result) => {
      if (result.ok) { setSnapshot(result.value); return }
      // A rejected write must not leave the switch visually flipped while the
      // backend kept the old value: re-read the authoritative snapshot.
      refresh()
    }).catch(() => { refresh() })
  }
  const records = snapshot?.pluginConflictRecords ?? []
  // The Host reports which stored records the running tree still matches. History
  // is not a repair: a record written before a later change can describe a plugin
  // this Harness is currently running as the one it stopped, and presenting that
  // as current is what makes the panel read as if the official plugin lost.
  const active = new Set(snapshot?.pluginConflictActiveRecords ?? [])
  const activeCount = records.filter(record => active.has(record.id)).length
  return <section className={css.section}>
    <div className={css.sectionHeader}><div><div className={css.kicker}>Plugin Safety</div><strong className={css.sectionName}>插件冲突防护</strong></div><span className={`${css.badge} ${snapshot?.pluginConflictProtectionEnabled ? css.badgeLive : ''}`}>{snapshot === undefined ? (loadError === undefined ? '读取中' : '状态未知') : snapshot.pluginConflictProtectionEnabled ? '已开启' : '已关闭'}</span></div>
    <small className={css.sectionMeta}>默认开启。安装或加载第三方 DSH 插件时，系统会在该插件启动前检查重复 Tool、命令、设置 namespace、HTTP 路由、模型 Provider 和界面 Slot。冲突时以官方本体的插件优先：本插件自带的同名实现会让位；其余情况保留先启用的插件，并自动停用后加载的冲突条目。</small>
    {loadError === undefined ? null : <div className={css.alert} role="alert">冲突防护状态读取失败：{loadError}</div>}
    <label className={css.extensionRow}><span><strong>自动修复冲突</strong><small>默认开启：重复注册由本体自己的注册校验报告，冲突的第三方插件可能因此启动失败。开启时本插件会在冲突插件启动前停用它；关闭后本插件不再拦截任何条目的启动。</small></span><input className={css.switch} aria-label="自动修复插件冲突" type="checkbox" checked={snapshot?.pluginConflictProtectionEnabled === true} onChange={(event) => { update(event.target.checked) }} disabled={input.setEnabled === undefined || snapshot === undefined} /></label>
    {records.length > 0 ? <div className={css.accountList}>{records.slice(-5).reverse().map(record => <div className={css.accountRow} key={record.id}><div className={css.accountIdentity}><strong className={css.accountName}>{record.yieldedToOfficial === true ? `已让位给官方 ${record.keptModuleName}` : `已自动停用 ${record.disabledModuleName}`}</strong><small className={css.accountEmail}>{record.resource}：{record.resourceName} 由 {record.keptModuleName} 提供</small></div><span className={css.badge}>{active.has(record.id) ? '生效中' : '已失效'}</span></div>)}</div> : <small className={css.sectionMeta}>尚未发现可识别的插件资源冲突。</small>}
    {records.length === 0 ? null : <small className={css.sectionMeta}>{activeCount === 0 ? '以上记录均为历史：当前运行树中已无生效的冲突。' : `${activeCount} 条记录在当前运行树中仍然生效。`}</small>}
  </section>
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(2)} MB`
}

/**
 * Headroom context compression panel: total switch, live savings counters,
 * and the plain-language explanation of how the compression works, with the
 * upstream Apache-2.0 attribution.
 */
/** Severity → tone for a review finding.
 *
 * Two vocabularies reach this UI and both must land on a real tone:
 * council findings use `info | warning | blocker` (see `SEVERITY_RANK` in
 * `engine-council.ts`), advisor notes use `nit | concern | blocker` (see
 * `AdvisorSeverity`). An earlier version knew neither and mapped every value
 * to `unknown`, so severity colouring never applied to anything. */
export function severityTone(severity: string): 'blocker' | 'warning' | 'info' | 'unknown' {
  switch (severity.trim().toLowerCase()) {
    case 'blocker': case 'critical': case 'fatal':
      return 'blocker'
    // `concern` is the advisor's middle tier; `warning` is the council's.
    case 'warning': case 'concern': case 'major': case 'error': case 'high':
      return 'warning'
    // `nit` is the advisor's lowest tier; `info` is the council's.
    case 'info': case 'nit': case 'minor': case 'note': case 'low': case 'medium': case 'moderate': case 'warn':
      return 'info'
    default:
      return 'unknown'
  }
}

/** One review finding, rendered the same way in the live job and in history. */
function CouncilFindingRow(input: {
  readonly engine: string
  readonly severity: string
  readonly title: string
  readonly evidence?: string
}): ReactNode {
  const tone = severityTone(input.severity)
  return <li className={css.findingRow}>
    <span className={`${css.findingSeverity} ${css[`findingSeverity_${tone}`] ?? ''}`}>{input.severity}</span>
    <div className={css.findingBody}>
      <strong className={css.findingTitle}>{input.title}</strong>
      {input.evidence === undefined || input.evidence === '' ? null : <p className={css.findingEvidence}>{input.evidence}</p>}
    </div>
    <span className={css.findingEngine}>{input.engine}</span>
  </li>
}

function HeadroomPanel(input: {
  readonly status?: (() => Promise<RemoteResult<HeadroomStats>>) | undefined
  readonly setEnabled?: ((enabled: boolean) => Promise<RemoteResult<HeadroomStats>>) | undefined
  readonly update?: ((patch: { readonly thresholdChars?: number; readonly minSavingsRatio?: number; readonly dedupEnabled?: boolean; readonly excludeTools?: readonly string[]; readonly foldReads?: boolean; readonly codeSkeletonEnabled?: boolean; readonly foldPolicy?: 'reversible' | 'max' }) => Promise<RemoteResult<HeadroomStats>>) | undefined
  readonly language: 'zh' | 'en'
}): ReactNode {
  const isZh = input.language === 'zh'
  const [snapshot, setSnapshot] = useState<HeadroomStats | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const refresh = (): void => {
    if (input.status === undefined) return
    void input.status().then((result) => {
      if (result.ok) setSnapshot(result.value)
    }).catch(() => undefined)
  }
  useEffect(() => {
    refresh()
  }, [input.status])
  const update = (enabled: boolean): void => {
    if (input.setEnabled === undefined) return
    setBusy(true)
    void input.setEnabled(enabled).then((result) => {
      if (result.ok) setSnapshot(result.value)
      else refresh()
    }).catch(() => { refresh() }).finally(() => { setBusy(false) })
  }
  const updateKnob = (patch: Parameters<NonNullable<typeof input.update>>[0]): void => {
    if (input.update === undefined) return
    setBusy(true)
    void input.update(patch).then((result) => {
      if (result.ok) setSnapshot(result.value)
      else refresh()
    }).catch(() => { refresh() }).finally(() => { setBusy(false) })
  }
  const saved = snapshot === undefined ? 0 : Math.max(0, snapshot.originalBytes - snapshot.compressedBytes)
  const savedPercent = snapshot !== undefined && snapshot.originalBytes > 0
    ? Math.round(saved / snapshot.originalBytes * 100)
    : 0
  // The headline is the four numbers a user can act on. The per-compressor
  // breakdown only matters once compression has actually happened — before
  // that it is fourteen rows of zeroes that push the explanation off-screen.
  const headline: readonly (readonly [string, string, boolean])[] = snapshot === undefined ? [] : [
    [isZh ? '已压缩工具输出' : 'Compressed results', String(snapshot.compressions), snapshot.compressions > 0],
    [isZh ? '节省' : 'Saved', savedPercent === 0 && saved === 0 ? '0 B' : `${formatBytes(saved)} · ${savedPercent}%`, saved > 0],
    [isZh ? '可取回原文' : 'Recoverable', formatBytes(snapshot.ccrBytes), snapshot.ccrEntries > 0],
    [isZh ? '模型取回' : 'Retrievals', String(snapshot.retrievals), snapshot.retrievals > 0],
  ]
  // Per-compressor counters. Only the ones that have fired are worth a row;
  // a zero means "this compressor never ran", which the reader does not need
  // told individually.
  const compressorStats: readonly (readonly [string, number])[] = snapshot === undefined ? [] : [
    [isZh ? '日志' : 'Log', snapshot.logCompressions],
    ['JSON', snapshot.jsonCompressions],
    [isZh ? 'diff' : 'Diff', snapshot.diffCompressions],
    [isZh ? '搜索' : 'Search', snapshot.searchCompressions],
    [isZh ? '散文' : 'Prose', snapshot.proseCompressions],
    ['HTML', snapshot.htmlCompressions],
    [isZh ? '表格' : 'Tabular', snapshot.tabularCompressions],
    [isZh ? '配置' : 'Config', snapshot.configCompressions],
    [isZh ? '代码骨架' : 'Code skeleton', snapshot.codeSkeletonCompressions],
    [isZh ? '无损折叠' : 'Lossless', snapshot.losslessCompressions],
    [isZh ? '去重' : 'Dedup', snapshot.dedupCompressions],
  ]
  const fired = compressorStats.filter(([, count]) => count > 0)
  return <section className={css.section}>
    <div className={css.sectionHeader}><div><div className={css.kicker}>HEADROOM</div><strong className={css.sectionName}>{isZh ? '上下文压缩（Headroom）' : 'Context compression (Headroom)'}</strong></div><span className={`${css.badge} ${snapshot?.enabled ? css.badgeLive : ''}`}>{snapshot?.enabled ? (isZh ? '已开启' : 'On') : (isZh ? '已关闭' : 'Off')}</span></div>
    <small className={css.sectionMeta}>{isZh
      ? '默认开启。AI 会话里最大的 token 开销往往不是对话本身，而是工具输出——动辄几千行的构建日志、测试输出、搜索结果和 JSON 响应。'
      : 'On by default. In AI sessions the largest token cost is rarely the conversation itself but tool output — thousands of lines of build logs, test output, search results, and JSON responses.'}</small>
    <label className={css.extensionRow}><span><strong>{isZh ? '启用上下文压缩' : 'Enable context compression'}</strong><small>{isZh ? '对超大工具输出先压缩再交给模型；会话记录仍保留完整原文，随时可取回。' : 'Compress oversized tool outputs before the model sees them; the session log keeps the full original.'}</small></span><input className={css.switch} aria-label={isZh ? '启用上下文压缩' : 'Enable context compression'} type="checkbox" checked={snapshot?.enabled === true} onChange={(event) => { update(event.target.checked) }} disabled={input.setEnabled === undefined || busy} /></label>
    <label className={css.extensionRow}><span><strong>{isZh ? '跨回合去重' : 'Cross-turn dedup'}</strong><small>{isZh ? '后面回合重复出现的工具输出折叠为一行指针，原始内容仍在上文可见。' : 'Tool output repeated from an earlier turn folds into a one-line pointer; the original stays visible in context.'}</small></span><input className={css.switch} aria-label={isZh ? '跨回合去重' : 'Cross-turn dedup'} type="checkbox" checked={snapshot?.dedupEnabled === true} onChange={(event) => { updateKnob({ dedupEnabled: event.target.checked }) }} disabled={input.update === undefined || busy} /></label>
    <label className={css.extensionRow}><span><strong>{isZh ? '文件读取无损折叠' : 'Fold file reads losslessly'}</strong><small>{isZh ? '默认关闭：文件读取保持字节级精确（Edit 匹配依赖原文）。开启后仅做可逆折叠（如 rg --heading 归并），仍不做有损压缩。' : 'Off by default: file reads stay byte-exact (Edit matching depends on the original bytes). When on, only reversible folds (e.g. ripgrep --heading grouping) apply — never lossy compression.'}</small></span><input className={css.switch} aria-label={isZh ? '文件读取无损折叠' : 'Fold file reads losslessly'} type="checkbox" checked={snapshot?.foldReads === true} onChange={(event) => { updateKnob({ foldReads: event.target.checked }) }} disabled={input.update === undefined || busy} /></label>
    <label className={css.extensionRow}><span><strong>{isZh ? '代码文件骨架化（收益最大）' : 'Skeletonize code files (biggest win)'}</strong><small>{isZh ? '默认开启。只作用于大源码文件的读取结果：保留的每一行都是逐字节原文（含行号），仅把连续的函数／方法正文折叠成一行标记并注明行号区间。省下的是正文，不是接口——导入、类型、签名、装饰器、文档注释全部保留。需要正文时，模型可自行用 headroom_retrieve 取回原文，或用 read 带 offset 重读该区间。实测：读文件类输出占工具输出的 85%，而 Harness 每一步都会重发整段历史，压缩它等于把它按 ~10 倍退还给你。' : 'On by default, and applied only to large source-file reads: every retained line is byte-exact (line numbers included); only contiguous runs of function/method bodies fold into a single marker naming its line range. What is dropped is implementation, never interface — imports, types, signatures, decorators, and doc comments all survive. When the model needs a body it calls headroom_retrieve for the original or re-reads that range with offset. Measured: read output is 85% of all tool bytes, and the Harness re-sends the whole transcript every step — compressing it refunds that ~10x.'}</small></span><input className={css.switch} aria-label={isZh ? '代码文件骨架化' : 'Skeletonize code files'} type="checkbox" checked={snapshot?.codeSkeletonEnabled === true} onChange={(event) => { updateKnob({ codeSkeletonEnabled: event.target.checked }) }} disabled={input.update === undefined || busy} /></label>
    <label className={css.extensionRow}><span><strong>{isZh ? '无损折叠优先（可关：改为最大压缩）' : 'Prefer lossless folds (off = maximum compression)'}</strong><small>{isZh ? '默认开启：一个可逆折叠只要收益足够（省 ≥40%）就直接交付，零精度损失，后面的压缩器不再为它重做一遍。关掉后每个可逆渲染都必须先被类型压缩器比一遍，谁更小用谁；折叠仍然兜底，类型化渲染仍然带可检索标记。分段拼接、以及跨回合去重指针（重复片段折成「同上一条结果」）同样适用。实测同一份重复行日志：开启时无损折叠到 5.1%，关闭时有损压缩到 3.2%。' : 'On by default: a reversible fold that saves enough (≥40%) is delivered as is, at zero accuracy cost, and no later compressor re-decides it — a mixed-content section splice follows the same rule. Turned off, every one of them has to be beaten by the compressor for its own shape first — whoever is smaller wins, while the fold still ships as the fallback and every lossy rendering keeps a resolvable marker. The same applies to a mixed-content section splice and to the cross-turn pointer over a repeated run ("same as earlier tool result"). Measured on one repeated-run log: 5.1% lossless with it on, 3.2% lossy with it off.'}</small></span><input className={css.switch} aria-label={isZh ? '无损折叠优先' : 'Prefer lossless folds'} type="checkbox" checked={snapshot?.foldPolicy !== 'max'} onChange={(event) => { updateKnob({ foldPolicy: event.target.checked ? 'reversible' : 'max' }) }} disabled={input.update === undefined || busy} /></label>
    {snapshot === undefined ? null : <div className={css.statGrid}>
      {headline.map(([label, value]) => <div className={css.statCell} key={label}>
        <small className={css.statLabel}>{label}</small>
        <strong className={css.statValue}>{value}</strong>
      </div>)}
    </div>}
    {snapshot === undefined ? null : <details className={css.details}>
      <summary className={css.detailsSummary}>{fired.length === 0
        ? (isZh ? '压缩器明细（尚未压缩过任何输出）' : 'Per-compressor detail (nothing compressed yet)')
        : fired.length === compressorStats.length
          ? (isZh ? `压缩器明细（${compressorStats.length} 类全部命中）` : `Per-compressor detail (all ${compressorStats.length} kinds)`)
          : (isZh ? `压缩器明细（${compressorStats.length} 类中 ${fired.length} 类命中）` : `Per-compressor detail (${fired.length} of ${compressorStats.length} kinds)`)}</summary>
      <div className={css.chipGrid}>
        {compressorStats.map(([label, count]) => <span className={count > 0 ? css.statChip : `${css.statChip} ${css.statChipIdle}`} key={label}>
          {label}<b>{count}</b>
        </span>)}
        <span className={snapshot.protectedCount > 0 ? css.statChip : `${css.statChip} ${css.statChipIdle}`}>
          {isZh ? '原样放行' : 'Verbatim'}<b>{snapshot.protectedCount}</b>
        </span>
      </div>
    </details>}
    {snapshot === undefined ? null : <details className={css.details}>
      <summary className={css.detailsSummary}>{isZh ? `字节明细（原文 ${formatBytes(snapshot.originalBytes)} → 压缩后 ${formatBytes(snapshot.compressedBytes)}）` : `Byte detail (${formatBytes(snapshot.originalBytes)} → ${formatBytes(snapshot.compressedBytes)})`}</summary>
      <div className={css.chipGrid}>
        <span className={css.statChip}>{isZh ? '原文' : 'Original'}<b>{formatBytes(snapshot.originalBytes)}</b></span>
        <span className={css.statChip}>{isZh ? '压缩后' : 'Compressed'}<b>{formatBytes(snapshot.compressedBytes)}</b></span>
        <span className={css.statChip}>{isZh ? '可取回条目' : 'Recoverable'}<b>{snapshot.ccrEntries}</b></span>
        <span className={css.statChip}>{isZh ? '取回失败' : 'Retrieve misses'}<b>{snapshot.retrieveMisses}</b></span>
        <span className={snapshot.ccrWriteRefusals > 0 ? css.statChip : `${css.statChip} ${css.statChipIdle}`}>{isZh ? '仓储拒写' : 'Writes refused'}<b>{snapshot.ccrWriteRefusals}</b></span>
        <span className={snapshot.foldDeferred > 0 ? css.statChip : `${css.statChip} ${css.statChipIdle}`}>{isZh ? '折叠/拼接/指针进入竞争' : 'Folds/splices/pointers contested'}<b>{snapshot.foldDeferred}</b></span>
        <span className={snapshot.foldSuperseded > 0 ? css.statChip : `${css.statChip} ${css.statChipIdle}`}>{isZh ? '折叠/拼接/指针被取代' : 'Folds/splices/pointers superseded'}<b>{snapshot.foldSuperseded}</b></span>
        <span className={snapshot.foldSettled > 0 ? css.statChip : `${css.statChip} ${css.statChipIdle}`}>{isZh ? '折叠/拼接/指针兜底交付' : 'Folds/splices/pointers settled'}<b>{snapshot.foldSettled}</b></span>
      </div>
    </details>}
    <details className={css.sectionMeta}>
      <summary style={{ cursor: 'pointer', margin: '8px 0' }}>{isZh ? '它是如何节省 token 的？（工作原理）' : 'How does it save tokens? (How it works)'}</summary>
      <div style={{ display: 'grid', gap: 8, padding: '8px 0' }}>
        <p><strong>{isZh ? '1. 日志压缩器（收益最大）' : '1. Log compressor (biggest win)'}</strong><br />{isZh
          ? '构建/测试输出按行分级打分：ERROR/FATAL 得分最高必保，WARN 去重后保留（只把尾部数字、内存地址、路径归一化再比对，不同错误不会误合并），堆栈按语言识别并折叠运行时帧，汇总行保留，其余行收敛为一行统计，如「[842 lines omitted: 3 ERROR, 12 WARN, 827 INFO]」。保留多少行由信息饱和度算法自适应决定：内容越重复压得越狠。实测 10,144 token 的日志压到 1,260 token，且 FATAL 行原样保留。'
          : 'Build/test output is scored line by line: ERROR/FATAL always survive, warnings are deduplicated (only trailing digits, addresses, and paths are normalized before comparing, so distinct errors never merge), stack traces are recognized per language and runtime frames collapse, summary lines survive, and everything else folds into one line like "[842 lines omitted: 3 ERROR, 12 WARN, 827 INFO]". How many lines survive is decided adaptively by information saturation: the more repetitive the content, the harder it compresses. A 10,144-token log compresses to 1,260 tokens with the FATAL lines byte-identical.'}</p>
        <p><strong>{isZh ? '2. JSON 表格化（SmartCrusher）' : '2. JSON tabular compaction (SmartCrusher)'}</strong><br />{isZh
          ? '搜索结果、文件列表、API 响应等往往是几十上百个结构相同的对象，字段名在每行重复出现。压缩器把同构对象数组改写成一行「[50]{name:string,size:int,status:string}」声明加 CSV 行——字段名只出现一次。异构数组按类别字段分桶，各自表格化；超长字符串、base64、HTML 等不透明内容替换为占位标记。节省不足 30% 时自动放弃，保持原文。'
          : 'Search results, file listings, and API responses are often dozens of identically-shaped objects with field names repeated on every row. The compactor rewrites uniform arrays of objects into one "[50]{name:string,size:int,status:string}" declaration plus CSV rows — field names appear once. Heterogeneous arrays partition into buckets by a discriminator field; long strings, base64, and HTML become placeholder markers. If the rendering saves less than 30%, the original text is kept.'}</p>
        <p><strong>{isZh ? '3. 可逆缓存（CCR）——有损上线，无损落地' : '3. Reversible cache (CCR) — lossy on the wire, lossless end-to-end'}</strong><br />{isZh
          ? '每一段被删减的内容原文都存在本地缓存里，压缩文本中嵌入「hash=xxxx」标记，并且 AI 多了一个 headroom_retrieve 工具：当它判断被省略的细节重要时，自己调用工具取回完整原文。所以压缩是有损的传输、无损的信息——模型可以随时反悔。'
          : 'Every dropped excerpt is stored locally, the compressed text carries a "hash=xxxx" marker, and the model gains a headroom_retrieve tool: whenever it decides the omitted detail matters, it calls the tool to fetch the full original. Compression is lossy in transit but lossless in information — the model can always change its mind.'}</p>
        <p><strong>{isZh ? '4. 代码骨架化——为什么它值得单列' : '4. Code skeletonization — why it is called out separately'}</strong><br />{isZh
          ? '日志、JSON、diff、搜索、表格、配置、散文都是「按形状」路由的，源码没有形状可循，所以本移植版本原先对源码完全不动手。但实测显示：读文件的输出占全部工具输出字节的 85%，而 Harness 每一步都会把整个会话历史重发一遍——一次 50KB 的读取会被反复传输将近 10 次。骨架化只保留接口行（声明、签名、导入、装饰器、文档注释、行号）并保持逐字节原文，把整段正文折成一行标记；被折叠的正文随时可经 CCR 取回。这样 Edit 依然能在保留行上精确匹配，而省下的是重复传输量。'
          : 'Logs, JSON, diffs, searches, tables, configs, and prose are all routed by *shape*. Source code has no shape signature, so this port originally left it entirely alone. Measurement changed that conclusion: read output is 85% of all tool-output bytes, and the Harness re-sends the whole transcript on every step — one 50KB read is transmitted nearly ten times. Skeletonization keeps only the interface lines (declarations, signatures, imports, decorators, doc comments, line numbers) byte-exact and folds whole body runs into a single marker; every dropped body stays retrievable from CCR. Edit still matches precisely on retained lines, and what is saved is transmission, not interface.'}</p>
        <p><strong>{isZh ? '5. 会话记录不受影响' : '5. Session records are untouched'}</strong><br />{isZh
          ? '压缩只替换模型「看到」的内容投影；会话的持久日志仍写入完整的工具输出。历史回放、压缩汇总和取回都不丢信息。开关只影响之后的新工具输出。'
          : 'Compression replaces only the content projection the model sees; the durable session log still records the full tool output. History replay, compaction, and retrieval lose nothing. The switch affects only future tool results.'}</p>
        {snapshot === undefined ? null : <p style={{ opacity: 0.75 }}>{isZh
          ? `算法移植自开源项目 Headroom（github.com/headroomlabs-ai/headroom），遵循 Apache License 2.0。Copyright © Headroom Maintainers. 本次构建对齐：${snapshot.provenance}。本面板中的统计数字为本地计数，不会上报。`
          : `The algorithms are ported from the open-source Headroom project (github.com/headroomlabs-ai/headroom), Apache License 2.0. Copyright © Headroom Maintainers. This build tracks: ${snapshot.provenance}. The counters above are local only and never reported anywhere.`}</p>}
      </div>
    </details>
  </section>
}


/**
 * The code review surface.
 *
 * Two things this panel must not do. It must not present a review as a verdict:
 * the run reports what it reviewed, what it refused, and what it never reached, and
 * a panel that showed only the findings would make "three findings" mean the same
 * thing whether three files were read or thirty were skipped. So the coverage
 * counts and the skip reasons are part of the panel, not a detail behind a toggle.
 *
 * And it must not invent progress. A review started from here runs in the Host and
 * answers immediately, so the only way to know whether it finished is to ask again —
 * hence the poll while a run is in flight, and the refusal to show a percentage the
 * Host has not reported.
 */
/**
 * How often a running review is re-read.
 *
 * Long enough to be cheap, short enough that a finished review appears while the
 * user is still looking at the panel. The read returns the last report with the
 * runs, so this is the panel's whole refresh cost.
 */
const POLL_INTERVAL_MS = 3_000

/** A select's value as the mode it names; an unrecognized value is the shipped default rather than a write. */
const reviewModeValue = (value: string): NonNullable<FreeCodeGoReviewUpdate['reviewMode']> => value === 'record' || value === 'gate' ? value : 'off'

/** A select's value as the severity it names; anything else is the least severe option shown. */
const reviewThresholdValue = (value: string): NonNullable<FreeCodeGoReviewUpdate['reviewThreshold']> =>
  value === 'critical' || value === 'high' || value === 'medium' ? value : 'low'

function ReviewPanel(input: {
  readonly sessionId?: string | undefined
  readonly status?: ((sessionId: string) => Promise<RemoteResult<FreeCodeGoReviewStatus>>) | undefined
  readonly start?: ((sessionId: string, request: FreeCodeGoReviewStartRequest) => Promise<RemoteResult<FreeCodeGoReviewStatus>>) | undefined
  readonly update?: ((sessionId: string, patch: FreeCodeGoReviewUpdate) => Promise<RemoteResult<FreeCodeGoReviewStatus>>) | undefined
  readonly language: 'zh' | 'en'
}): ReactNode {
  const isZh = input.language === 'zh'
  const [snapshot, setSnapshot] = useState<FreeCodeGoReviewStatus | undefined>(undefined)
  /**
   * Why the panel is showing an error, and which action produced it.
   *
   * The kind is carried because the three failures need three different sentences:
   * a status read that failed, a setting that was not saved, and a review that would
   * not start are not the same problem, and one label over all three tells the user
   * to go and look at the wrong thing.
   */
  const [error, setError] = useState<{ readonly kind: 'read' | 'write' | 'start'; readonly message: string } | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const sessionId = input.sessionId
  const load = input.status
  /**
   * Read the surface, reporting why it could not be read.
   *
   * A failed read used to leave the panel showing a dash forever, which is the one
   * outcome a user cannot act on: assembly reads the workspace's rule files, and a
   * failure there is precisely the thing to be told about. The interval's repeated
   * failures collapse to one message because each write replaces the last.
   */
  const read = (id: string): void => {
    if (load === undefined) return
    void load(id).then((result) => {
      if (result.ok) { setSnapshot(result.value); setError(undefined) }
      else setError({ kind: 'read', message: result.error.message })
    }).catch((reason: unknown) => { setError({ kind: 'read', message: reason instanceof Error ? reason.message : String(reason) }) })
  }
  useEffect(() => {
    if (sessionId === undefined) return
    read(sessionId)
  }, [sessionId, load])
  const running = snapshot?.runs.some(run => run.phase !== 'done') === true
  useEffect(() => {
    if (!running || sessionId === undefined || load === undefined) return
    // A review started from this panel is fire-and-forget in the Host, so the run's
    // completion is only knowable by asking again. Polling stops the moment no run
    // is in flight, which is also the reason the interval is not a subscription.
    const timer = setInterval(() => { read(sessionId) }, POLL_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [running, sessionId, load])

  const apply = (
    patch: FreeCodeGoReviewUpdate,
    run: ((sessionId: string, patch: FreeCodeGoReviewUpdate) => Promise<RemoteResult<FreeCodeGoReviewStatus>>) | undefined,
  ): void => {
    if (sessionId === undefined || run === undefined) return
    setBusy(true)
    setError(undefined)
    void run(sessionId, patch).then((result) => {
      if (result.ok) setSnapshot(result.value)
      // A refused write leaves the old value in force, so the control must not be
      // left showing the new one: report it and re-read the authoritative state.
      else setError({ kind: 'write', message: result.error.message })
    }).catch((reason: unknown) => { setError({ kind: 'write', message: reason instanceof Error ? reason.message : String(reason) }) })
      .finally(() => { setBusy(false) })
  }

  const latest = snapshot?.runs.find(run => run.id === snapshot.report?.id) ?? snapshot?.runs[0]
  const report = snapshot?.report
  const findings = report?.comments.filter(comment => comment.state !== 'filtered') ?? []
  const filtered = report?.comments.filter(comment => comment.state === 'filtered') ?? []
  const blockers = snapshot?.runs.flatMap(run => run.error === undefined ? [] : [run]) ?? []

  return <section className={css.section}>
    <div className={css.sectionHeader}><div><div className={css.kicker}>REVIEW</div><strong className={css.sectionName}>{isZh ? '代码审查' : 'Code review'}</strong></div><span className={`${css.badge} ${snapshot === undefined || snapshot.mode === 'off' ? '' : css.badgeLive}`}>{snapshot === undefined ? '—' : snapshot.mode === 'off' ? (isZh ? '已关闭' : 'Off') : snapshot.mode === 'record' ? (isZh ? '记录' : 'Record') : (isZh ? '收尾门禁' : 'Gate')}</span></div>
    <small className={css.sectionMeta}>{isZh
      ? '审查每个改动文件，并按行给出发现与建议。分为两半：一半是完全确定性的（选目标、解析规则、算覆盖率、定位评论行号），另一半是模型读代码。覆盖率会对账：每个进入审查的文件都必须带着状态离开，被跳过或失败的文件必须说出原因。'
      : 'Reviews every changed file and reports findings with a line, a severity and a suggested fix where one exists. Half of it is deterministic — target selection, rule resolution, coverage accounting, comment relocation — and half is a model reading code. Coverage is reconciled: every file that entered leaves with a state, and a file that was skipped or failed says why.'}</small>
    {sessionId === undefined
      ? <div className={css.sectionMeta}>{isZh ? '打开一个工作区会话后即可在这里运行审查。' : 'Open a workspace conversation to run a review from here.'}</div>
      : null}
    {error === undefined ? null : <div className={css.alert} role="alert">{error.kind === 'read'
      ? (isZh ? `无法读取审查状态：${error.message}` : `The review status could not be read: ${error.message}`)
      : error.kind === 'start'
        ? (isZh ? `无法启动审查：${error.message}` : `The review could not be started: ${error.message}`)
        : (isZh ? `设置未保存：${error.message}` : `The setting was not saved: ${error.message}`)}</div>}
    {snapshot === undefined || sessionId === undefined ? null : <>
      <div className={css.extensionList}>
        <label className={css.extensionRow}><span><strong>{isZh ? '收尾审查模式' : 'Stop-time review'}</strong><small>{isZh
          ? '关闭：不做任何事，也不花钱。记录：每轮结束时审查一次并写入会话（可随时用 engineering_review_report 取回）。收尾门禁：同一个审查结果在达到阈值时注入一条消息，Agent 必须先回应它才能结束回合。工具 engineering_code_review 在任何模式下都能手动调用。'
          : 'Off: nothing runs and nothing is spent. Record: one pass per turn, written to the session and re-readable through engineering_review_report. Gate: the same pass injects a message when a finding reaches the threshold, so the agent has to answer it before the turn can end. The engineering_code_review tool works in every mode.'}</small></span>            <select className={css.select} aria-label={isZh ? '收尾审查模式' : 'Stop-time review mode'} value={snapshot.mode} disabled={busy || input.update === undefined} onChange={(event) => { apply({ reviewMode: reviewModeValue(event.target.value) }, input.update) }}>
            <option value="off">{isZh ? '关闭' : 'Off'}</option>
            <option value="record">{isZh ? '记录' : 'Record'}</option>
            <option value="gate">{isZh ? '收尾门禁' : 'Gate'}</option>
          </select></label>
        <label className={css.extensionRow}><span><strong>{isZh ? '交付阈值' : 'Delivery threshold'}</strong><small>{isZh ? '只有达到该严重度的发现才会被注入；更轻的发现仍会记录在报告里。' : 'Only findings at or above this severity are injected; lighter ones are still recorded in the report.'}</small></span>            <select className={css.select} aria-label={isZh ? '交付阈值' : 'Delivery threshold'} value={snapshot.threshold} disabled={busy || input.update === undefined} onChange={(event) => { apply({ reviewThreshold: reviewThresholdValue(event.target.value) }, input.update) }}>
            <option value="critical">critical</option>
            <option value="high">high</option>
            <option value="medium">medium</option>
            <option value="low">low</option>
          </select></label>
        <label className={css.extensionRow}><span><strong>{isZh ? '逐文件子 Agent 深审' : 'Per-file subagent review'}</strong><small>{isZh
          ? '开启后每个文件由一个独立的只读子 Agent 审查：它能读整份文件、搜索调用方、打开测试覆盖的实现，因此「接口改了但没有改调用方」这类发现是被查证的，而不是猜的。代价是每个文件开一个子 Agent，所以默认关闭。'
          : 'When on, each file is reviewed by its own read-only child agent, which can read the whole file, search for callers, and open the implementation a test covers — so a finding like “the interface changed and no caller was updated” is checked rather than inferred. It opens one child per file, which is why it is off by default.'}</small></span>
          <input className={css.switch} aria-label={isZh ? '逐文件子 Agent 深审' : 'Per-file subagent review'} type="checkbox" checked={snapshot.deep} disabled={busy || input.update === undefined} onChange={(event) => { apply({ reviewDeep: event.target.checked }, input.update) }} /></label>
        <label className={css.extensionRow}><span><strong>{isZh ? '高危发现对抗复核' : 'Adversarial re-check'}</strong><small>{isZh
          ? '对 critical / high 发现再问一次「这条能否被 diff 推翻」。结论只有三种：有证据反驳且确认数不足则降级（仍保留在报告中），无结论则原样发布，出错则原样发布并记录原因。默认关闭，因为它为每条高危发现多花一次调用。'
          : 'Asks once more whether a critical or high finding can be disproved by the diff. There are three outcomes: refuted with evidence and short of quorum means it is downgraded (and kept in the report), no verdict means it is published unchanged, and a failure means it is published unchanged with the reason recorded. Off by default because it spends a call per escalated finding.'}</small></span>
          <input className={css.switch} aria-label={isZh ? '高危发现对抗复核' : 'Adversarial re-check'} type="checkbox" checked={snapshot.escalation} disabled={busy || input.update === undefined} onChange={(event) => { apply({ reviewEscalation: event.target.checked }, input.update) }} /></label>
      </div>
      <div className={css.poolToolbar}>
        <span className={css.poolToolbarNote}>{snapshot.workspace}</span>
        <div className={css.poolToolbarActions}>
          <button className={css.button} type="button" disabled={busy || running || input.start === undefined} onClick={() => {
            if (input.start === undefined) return
            setBusy(true)
            setError(undefined)
            void input.start(sessionId, { mode: 'workspace' }).then((result) => {
              if (result.ok) setSnapshot(result.value)
              else setError({ kind: 'start', message: result.error.message })
            }).catch((reason: unknown) => { setError({ kind: 'start', message: reason instanceof Error ? reason.message : String(reason) }) }).finally(() => { setBusy(false) })
          }}>{running ? (isZh ? '审查进行中…' : 'Review running…') : (isZh ? '审查当前改动' : 'Review current changes')}</button>
        </div>
      </div>
      {latest === undefined ? <div className={css.sectionMeta}>{isZh ? '还没有在本工作区运行过审查。' : 'No review has run in this workspace yet.'}</div> : null}
      {latest === undefined ? null : <div className={css.statGrid}>
        <div className={css.statCell}><small className={css.statLabel}>{isZh ? '状态' : 'State'}</small><strong className={css.statValue}>{latest.state ?? latest.phase}</strong></div>
        <div className={css.statCell}><small className={css.statLabel}>{isZh ? '已审查/总数' : 'Reviewed / total'}</small><strong className={css.statValue}>{latest.reviewed}/{latest.files}</strong></div>
        <div className={css.statCell}><small className={css.statLabel}>{isZh ? '发现' : 'Findings'}</small><strong className={css.statValue}>{latest.findings}</strong></div>
        <div className={css.statCell}><small className={css.statLabel}>{isZh ? '跳过/失败' : 'Skipped / failed'}</small><strong className={css.statValue}>{latest.skipped}/{latest.failed}</strong></div>
      </div>}
    </>}
    {blockers.length === 0 ? null : <div className={css.poolFootnote}>
      {blockers.map(run => <div key={run.id}>{isZh ? '审查未完成' : 'The review did not finish'}（{run.id}）：{run.error}</div>)}
    </div>}
    {report === undefined ? null : <details className={css.details}>
      <summary className={css.detailsSummary}>{isZh
        ? `发现明细（${findings.length} 条${filtered.length === 0 ? '' : `，另有 ${filtered.length} 条被事实核查过滤`}）`
        : `Findings (${findings.length}${filtered.length === 0 ? '' : `, plus ${filtered.length} removed by the fact-check`})`}</summary>
      <div className={css.findingList}>
        {findings.map(comment => <article className={css.findingRow} key={comment.id}>
          <div className={css.councilJobHead}>
            <span className={css.findingSeverity}>{comment.severity}</span>
            <strong className={css.findingTitle}>{comment.path}{comment.startLine === 0 ? '' : `:${comment.startLine}`}</strong>
            <small className={css.councilJobId}>{comment.category}{comment.reviewer === undefined ? '' : ` · ${comment.reviewer}`}</small>
          </div>
          <p className={css.findingBody}>{comment.content}</p>
          {comment.suggestionCode === undefined ? null : <pre className={css.findingEvidence}>{comment.suggestionCode}</pre>}
          {comment.ruleSource === undefined ? null : <small className={css.poolSub}>{isZh ? '规则来源：' : 'Rule: '}{comment.ruleSource}</small>}
        </article>)}
      </div>
      <div className={css.chipGrid}>
        {report.files.map(file => <span className={`${css.poolChip} ${file.state === 'reviewed' ? '' : file.state === 'failed' ? css.poolChipDanger : css.poolChipWarn}`} key={`${file.state}:${file.path}`} title={file.reason ?? ''}>
          {file.path} · {file.state}{file.reason === undefined ? '' : ` · ${file.reason}`}
        </span>)}
      </div>
      <div className={css.poolFootnote}>
        {isZh
          ? `覆盖率 ${Math.round(report.coverage.coverageRate * 100)}%（${report.coverage.reviewedFiles}/${report.coverage.totalFiles}）· 审查者 ${report.reviewers.join(', ') || '—'} · 模型 ${report.model ?? '—'}`
          : `Coverage ${Math.round(report.coverage.coverageRate * 100)}% (${report.coverage.reviewedFiles}/${report.coverage.totalFiles}) · reviewers ${report.reviewers.join(', ') || '—'} · model ${report.model ?? '—'}`}
      </div>
    </details>}
    <details className={css.sectionMeta}>
      <summary style={{ cursor: 'pointer', margin: '8px 0' }}>{isZh ? '这个审查为什么可信？（四条约束）' : 'Why is this review trustworthy? (four constraints)'}</summary>
      <div style={{ display: 'grid', gap: 8, padding: '8px 0' }}>
        <p><strong>{isZh ? '1. 覆盖对账，不留无声的缺口' : '1. Coverage is reconciled'}</strong><br />{isZh
          ? '每个进入审查的文件都必须以「已审查 / 已跳过 / 失败」三者之一离开，且跳过与失败必须带原因（规则排除、二进制、超大、不可读、文件数上限、预算拒绝）。少一个文件就会在报告的 notes 里点名，而不是从分母里悄悄消失。'
          : 'Every file that enters leaves as reviewed, skipped or failed, and the last two must carry a reason (a rule excluded it, it is binary, oversized, unreadable, past the file limit, or refused by the budget). A file that goes missing is named in the report’s notes rather than quietly dropping out of the denominator.'}</p>
        <p><strong>{isZh ? '2. 行号必须有证据' : '2. A line number needs evidence'}</strong><br />{isZh
          ? '评论落行只有四种合法路径：落在 diff 的 hunk 里、引文在文件中唯一匹配、旧侧行号经 hunk 映射到新侧、或者干脆不给行号（0,0）。映射到一个被删掉的行会被拒绝。宁可说「不知道在哪一行」，也不给一个看起来精确的错行号。'
          : 'A comment lands on a line by one of four routes: inside a diff hunk, a unique quotation match, an old-side line translated through the hunks, or no line at all (0,0). A mapped line that was deleted is refused. Saying “I do not know which line” beats a precise-looking wrong one.'}</p>
        <p><strong>{isZh ? '3. 事实核查只删能被证明错的' : '3. The fact-check only removes what it can disprove'}</strong><br />{isZh
          ? '后置过滤是 fail-open 的：调用失败、响应读不出来、没有这条发现的判定、判定缺少 id，一律保留。想删除必须给出理由，否则视为批准。宁可留下一条可疑的发现，也不隐藏一条真的。'
          : 'The post-filter fails open: a failed call, an unreadable response, no verdict for that finding, or a verdict without an id all keep the finding. A removal must state a reason; a removal without one counts as approval. Keeping a doubtful finding beats hiding a real one.'}</p>
        <p><strong>{isZh ? '4. 花掉的每一分钱都记账' : '4. Every token is metered'}</strong><br />{isZh
          ? '分组、计划、逐文件审查、事实核查、复核的用量都会在下一次决策之前计入预算；超预算的组会跑完「最后一轮」并把结论交出来，而不是把半成品丢掉。没有哪个阶段可以偷偷花钱。'
          : 'Grouping, planning, per-file review, fact-checking and adjudication are all folded into the budget before the next decision. A group over its budget runs one final round and still produces a verdict instead of discarding half-finished work. No stage may spend without being metered.'}</p>
      </div>
    </details>
  </section>
}

/**
 * Deferred tool schemas.
 *
 * The panel exists because the win is invisible: nothing about how a tool
 * behaves changes, only how many bytes of JSONSchema ride along on every
 * request. Without a readout, a user cannot tell whether the switch did
 * anything, and the numbers are the whole argument for leaving it on.
 */
/**
 * The image and video generation switch.
 *
 * It documents the routes as well as the tools, because the question a user arrives
 * with is "can this draw me a picture, and with what?" — and the answer is a property
 * of the providers they configured, not of this plugin's source. The two name lists
 * come from the Host: `gated` is what the switch owns and `registered` is what this
 * profile actually mounted, so a profile with no Agnes account is not described as
 * missing tools it never had.
 */
function MediaGenerationPanel(input: {
  readonly status?: (() => Promise<RemoteResult<FreeCodeGoMediaToolStatus>>) | undefined
  readonly setEnabled?: ((enabled: boolean) => Promise<RemoteResult<FreeCodeGoMediaToolStatus>>) | undefined
  readonly language: 'zh' | 'en'
}): ReactNode {
  const isZh = input.language === 'zh'
  const [snapshot, setSnapshot] = useState<FreeCodeGoMediaToolStatus | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const refresh = (): void => {
    if (input.status === undefined) return
    void input.status().then((result) => {
      if (result.ok) setSnapshot(result.value)
    }).catch(() => undefined)
  }
  useEffect(() => {
    refresh()
  }, [input.status])
  const toggle = (enabled: boolean): void => {
    if (input.setEnabled === undefined) return
    setBusy(true)
    setError(undefined)
    void input.setEnabled(enabled).then((result) => {
      if (result.ok) setSnapshot(result.value)
      // A refused write keeps the old value in force, so the switch must not be left
      // flipped: report it and re-read the authoritative snapshot.
      else { setError(result.error.message); refresh() }
    }).catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)); refresh() }).finally(() => { setBusy(false) })
  }
  /**
   * The wire protocol each provider family is spoken to with.
   *
   * Kept beside the switch rather than only in the README because the useful question
   * is "does *my* provider have a route here?", and that is answered by matching the
   * id the user typed into the Harness model page. The protocol is chosen from the
   * provider, never from the model name: a model whose id contains "video" is still
   * served the way its provider serves it.
   */
  const videoProtocols: readonly (readonly [string, string])[] = [
    ['kling / kuaishou / 可灵', '/videos/text2video · image2video · multi-image2video → 同路径 + {id} · HS256 JWT · 5 或 10 秒'],
    ['volcengine / ark / seedance / doubao', '/contents/generations/tasks → /contents/generations/tasks/{id}'],
    ['dashscope / aliyun / qwen / wanx', '/api/v1/services/aigc/video-generation/video-synthesis（需 X-DashScope-Async: enable）→ /api/v1/tasks/{id}'],
    ['minimax / hailuo', '/v2/video_generation → /v2/query/video_generation/{id}'],
    ['vidu', '/ent/v2/text2video · img2video · start-end2video · reference2video → /ent/v2/tasks/{id}/creations · Authorization: Token'],
    ['google / gemini（Veo）', '/models/{model}:predictLongRunning → operation name'],
    ['xai / grok', '/videos/generations → /videos（给源视频时 /videos/edits · /videos/extensions）· 2–10 秒'],
    ['openai', '/videos → /videos/{id}'],
    ['网关与任何未识别 provider', '/videos/generations → /videos/generations/{id}'],
  ]
  const imageProtocols: readonly (readonly [string, string])[] = [
    ['openai / grok / 网关 / 未识别 provider', '/images/generations；带参考图改走 /images/edits'],
    ['volcengine / ark / seedance / doubao', '仍是 /images/generations，源图放 image: [...]（Seedream 融合形状）'],
    ['google / gemini', '/models/{model}:generateContent，responseModalities: [TEXT, IMAGE]'],
    ['google / gemini + 模型名含 imagen', '/models/{model}:predict，源图必须内联 base64'],
    ['dashscope / qwen / aliyun', '/api/v1/services/aigc/multimodal-generation/generation，size 写作 2048*2048'],
  ]
  const protocolPanel = (title: string, rows: readonly (readonly [string, string])[]): ReactNode => (
    <details className={css.details}>
      <summary className={css.detailsSummary}>{title}</summary>
      <div style={{ display: 'grid', gap: 6, padding: '8px 0' }}>
        {rows.map(([provider, endpoint]) => <div key={provider}><strong>{provider}</strong><br /><code>{endpoint}</code></div>)}
      </div>
    </details>
  )
  return <section className={css.section}>
    <div className={css.sectionHeader}><div><div className={css.kicker}>MEDIA</div><strong className={css.sectionName}>{isZh ? '生图与视频' : 'Image and video generation'}</strong></div><span className={`${css.badge} ${snapshot?.enabled ? css.badgeLive : ''}`}>{snapshot?.enabled ? (isZh ? '已开启' : 'On') : (isZh ? '已关闭' : 'Off')}</span></div>
    <small className={css.sectionMeta}>{isZh
      ? '默认开启。开启后，AI 可以按「默认模型」里的图片／视频选择为你直接生成图片和视频；默认模型在设置 → 模型分类的下拉框里选。关掉它，这组工具会从模型工具表里整体消失（不是调用时报错），前提是这几份 JSONSchema 每步都随请求重发，而多数回合用不上。生音频与转写不受这个开关影响：一个往工作区写文件，一个从工作区读文件。'
      : 'On by default. With it on, the model can generate images and videos for you using the defaults chosen under Settings → Model categories. Turning it off removes the whole group from the model\'s tool list instead of failing the call: those JSONSchemas ride along with every request and most turns never use them. Audio generation and transcription are deliberately outside this switch — one writes a file into the workspace and the other reads one out of it.'}</small>
    {error === undefined ? null : <div className={css.alert} role="alert">{isZh ? `开关未能保存：${error}` : `The switch was not saved: ${error}`}</div>}
    <label className={css.extensionRow}><span><strong>{isZh ? '启用生图与生视频' : 'Enable image and video generation'}</strong><small>{isZh
      ? '开关本身就是模型的可见性：关闭后这些工具不会被注册，因此不可能出现「看得见却调不动」；重新打开即刻恢复。'
      : 'The switch *is* visibility: with it off these tools are not registered at all, so the model can never see one it cannot call. Turning it back on restores them immediately.'}</small></span><input className={css.switch} aria-label={isZh ? '启用生图与生视频' : 'Enable image and video generation'} type="checkbox" checked={snapshot?.enabled === true} onChange={(event) => { toggle(event.target.checked) }} disabled={input.setEnabled === undefined || busy} /></label>
    {snapshot === undefined ? null : <div className={css.statGrid}>
      <div className={css.statCell}><small className={css.statLabel}>{isZh ? '开关管辖' : 'Governed'}</small><strong className={css.statValue}>{snapshot.gated.length}</strong></div>
      <div className={css.statCell}><small className={css.statLabel}>{isZh ? '当前已注册' : 'Registered now'}</small><strong className={css.statValue}>{snapshot.registered.length}</strong></div>
      <div className={css.statCell}><small className={css.statLabel}>{isZh ? '生音频 / 转写（另计）' : 'Audio / transcribe (separate)'}</small><strong className={css.statValue}>{2}</strong></div>
    </div>}
    {snapshot === undefined ? null : <details className={css.details}>
      <summary className={css.detailsSummary}>{isZh ? `管辖的工具（${snapshot.gated.length} 个）` : `Tools this switch governs (${snapshot.gated.length})`}</summary>
      <div className={css.chipGrid}>
        {snapshot.gated.map(name => <span className={css.statChip} key={name}>{name}<b>{snapshot.registered.includes(name) ? (isZh ? '已注册' : 'registered') : (isZh ? '未注册' : 'absent')}</b></span>)}
      </div>
    </details>}
    <details className={css.sectionMeta}>
      <summary style={{ cursor: 'pointer', margin: '8px 0' }}>{isZh ? '支持哪些协议和模型？' : 'Which protocols and models are supported?'}</summary>
      <div style={{ display: 'grid', gap: 8, padding: '8px 0' }}>
        {protocolPanel(isZh ? '生视频：按 provider 选的 9 条协议' : 'Video: nine protocols, chosen by provider', videoProtocols)}
        {protocolPanel(isZh ? '生图：按 provider 选的 5 条协议' : 'Image: five protocols, chosen by provider', imageProtocols)}
        <p><strong>{isZh ? '模型名单是活的，不是钉死的' : 'The model roster is live, not pinned'}</strong><br />{isZh
          ? '候选路线每次请求实时汇总四路来源：Harness「模型」页里你配置的提供商、托管目录、Logfare 目录、Agnes 目录。分类按名字自动识别（veo / seedance / kling / sora / wan → 视频；gpt-image / dall-e / imagen / flux / sdxl / stable-diffusion → 生图），也可以用上面的「模型分类」手动指定或改回去。调用带逐路线熔断：同一路线连续两次失败就先让位给健康路线五分钟；只有「路线本身的问题」（限流、额度、端点缺失）才降级到下一条，密钥错或 prompt 被拒会直接报错，不会换一条路线重复付费。'
          : 'Routes are collected live on every request from four sources: the providers you configured on the Harness Models page, the managed catalog, the Logfare directory, and the Agnes directory. Categories are inferred from the id (veo / seedance / kling / sora / wan → video; gpt-image / dall-e / imagen / flux / sdxl / stable-diffusion → image) and can be overridden by hand in Model categories above. Every call carries a per-route breaker: two consecutive failures put that route behind healthy ones for five minutes, and only a route\'s own problem (rate limit, quota, missing endpoint) falls through to the next one — a wrong key or a refused prompt fails outright rather than paying for another attempt.'}</p>
      </div>
    </details>
  </section>
}

function DeferredToolsPanel(input: {
  readonly status?: (() => Promise<RemoteResult<DeferredToolStatus>>) | undefined
  readonly setEnabled?: ((enabled: boolean) => Promise<RemoteResult<DeferredToolStatus>>) | undefined
  readonly language: 'zh' | 'en'
}): ReactNode {
  const isZh = input.language === 'zh'
  const [snapshot, setSnapshot] = useState<DeferredToolStatus | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const refresh = (): void => {
    if (input.status === undefined) return
    void input.status().then((result) => {
      if (result.ok) setSnapshot(result.value)
    }).catch(() => undefined)
  }
  useEffect(() => {
    refresh()
  }, [input.status])
  const toggle = (enabled: boolean): void => {
    if (input.setEnabled === undefined) return
    setBusy(true)
    setError(undefined)
    void input.setEnabled(enabled).then((result) => {
      if (result.ok) setSnapshot(result.value)
      // A refused write keeps the old value in force, so the switch must not be
      // left flipped: report it and re-read the authoritative snapshot.
      else { setError(result.error.message); refresh() }
    }).catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)); refresh() }).finally(() => { setBusy(false) })
  }
  const deferred = snapshot?.deferred ?? []
  return <section className={css.section}>
    <div className={css.sectionHeader}><div><div className={css.kicker}>TOOLS</div><strong className={css.sectionName}>{isZh ? '工具按需加载' : 'Tools on demand'}</strong></div><span className={`${css.badge} ${snapshot?.enabled ? css.badgeLive : ''}`}>{snapshot?.enabled ? (isZh ? '已开启' : 'On') : (isZh ? '已关闭' : 'Off')}</span></div>
    <small className={css.sectionMeta}>{isZh
      ? '默认开启。工具清单是每一次请求里最固定的那部分开销：本插件提供的图查询、记忆读写、检查点恢复、团队编排、媒体生成等工具，多数回合一个都用不上，但它们的 JSONSchema 每步都会随请求重发一遍。开启后这些工具暂时只以「名字」存在，模型用 tool_search 取回完整定义后即可正常调用。'
      : 'On by default. The tool list is the most fixed part of every request: this plugin\'s graph queries, memory reads/writes, checkpoint restore, team orchestration, and media generation go unused on most turns, yet their JSONSchema is re-sent with every step. When this is on, those tools exist as *names* only; the model calls tool_search to fetch the full definition and then uses them exactly as before.'}</small>
    {error === undefined ? null : <div className={css.alert} role="alert">{isZh ? `开关未能保存：${error}` : `The switch was not saved: ${error}`}</div>}
    <label className={css.extensionRow}><span><strong>{isZh ? '按需加载工具定义' : 'Load tool definitions on demand'}</strong><small>{isZh
      ? '只改变「何时把完整定义发给模型」，不改变工具本身：调用方式、权限、审计、结果格式全部不变。取回过的工具在本次会话内保持可用；被隐藏的工具如果被直接调用，会返回 UNKNOWN_TOOL 而不是静默失败，所以「看得到的」和「调得动的」永远一致。关闭后所有定义立刻回到请求里，代价是每步多付数千 token。'
      : 'Changes only *when* a full definition is sent, never the tool itself: calling convention, permissions, audit, and result format are identical. A fetched tool stays callable for the rest of the session; a hidden tool that is called anyway returns UNKNOWN_TOOL rather than failing silently, so what is visible and what is callable can never drift. Turning this off puts every definition back into the request, at the cost of a few thousand tokens per step.'}</small></span><input className={css.switch} aria-label={isZh ? '按需加载工具定义' : 'Load tool definitions on demand'} type="checkbox" checked={snapshot?.enabled === true} onChange={(event) => { toggle(event.target.checked) }} disabled={input.setEnabled === undefined || busy} /></label>
    {snapshot === undefined ? null : <div className={css.statGrid}>
      <div className={css.statCell}><small className={css.statLabel}>{isZh ? '按需加载' : 'Deferred'}</small><strong className={css.statValue}>{deferred.length}</strong></div>
      <div className={css.statCell}><small className={css.statLabel}>{isZh ? '每次请求省下' : 'Saved per request'}</small><strong className={css.statValue}>~{snapshot.deferredTokens}</strong></div>
      <div className={css.statCell}><small className={css.statLabel}>{isZh ? '按需范围生效中' : 'Deferral scopes active'}</small><strong className={css.statValue}>{snapshot.activeAgents}</strong></div>
      <div className={css.statCell}><small className={css.statLabel}>{isZh ? '常驻定义' : 'Always immediate'}</small><strong className={css.statValue}>{formatBytes(snapshot.immediateChars)}</strong></div>
    </div>}
    {deferred.length === 0 ? null : <details className={css.details}>
      <summary className={css.detailsSummary}>{isZh ? `按需加载的工具明细（${deferred.length} 个，${formatBytes(snapshot?.deferredChars ?? 0)}）` : `Deferred tool detail (${deferred.length} tools, ${formatBytes(snapshot?.deferredChars ?? 0)})`}</summary>
      <div className={css.chipGrid}>
        {deferred.map(entry => <span className={css.statChip} key={entry.name}>{entry.name}<b>{formatBytes(entry.chars)}</b></span>)}
      </div>
    </details>}
    <details className={css.sectionMeta}>
      <summary style={{ cursor: 'pointer', margin: '8px 0' }}>{isZh ? '为什么不把工具清单写进说明里？（缓存纪律）' : 'Why isn\'t the tool list written into the description? (cache discipline)'}</summary>
      <div style={{ display: 'grid', gap: 8, padding: '8px 0' }}>
        <p><strong>{isZh ? '1. 工具说明必须保持静态' : '1. Tool descriptions must stay static'}</strong><br />{isZh
          ? '模型侧的前缀缓存以「系统提示 + 工具定义」为前缀。只要这段字节发生任何变化，它之后的所有 token（包括整段对话历史）都会缓存失效、按原价重算。按需加载的清单会随设置变化（工程模式开关、能力开关）而变化，一旦把它写进 tool_search 的说明文字里，改一次设置就会让之后每一次请求的前缀全部作废——省下的定义费用还不如赔进去的缓存。这是 Claude Code 源码里记录过的真实踩坑（动态 agent 清单曾占其缓存创建 token 的约 10.2%）。所以这里的说明文字是写死的，清单本身通过「无参数调用 tool_search」返回。'
          : 'Prompt caching keys off the prefix formed by the system prompt plus tool definitions. Any byte change there invalidates the cache for everything after it — including the whole conversation history — and those tokens are then billed at full price. The deferred set changes with settings (engineering mode, capability switches), so writing it into tool_search\'s description would void the cache prefix on every request after a settings change: a far larger loss than the definitions saved. Claude Code\'s own source records this exact failure (a dynamic agent list was ~10.2% of their fleet cache-creation tokens). The description here is therefore fixed, and the index itself comes back from a no-argument tool_search call.'}</p>
        <p><strong>{isZh ? '2. 为什么是「拒绝」而不是「隐藏」' : '2. Why deny instead of hide'}</strong><br />{isZh
          ? 'Harness 按 Agent 作用域推导发给模型的定义，而被拒绝的工具名在调用时会直接报 UNKNOWN_TOOL。也就是说，隐藏与可调用性是同一份数据决定的，不可能出现「模型看得见但调不了」或「调得到但没被告知」的情况。取回一批工具，就是把这个作用域里的拒绝列表收窄一次；全部取回后拒绝列表被完整撤销。'
          : 'The Harness derives the wire schema from each agent\'s tool scope, and a denied name fails a direct call with UNKNOWN_TOOL. Visibility and callability therefore come from one source of truth — the model can never see a tool it cannot call, nor call one it was not shown. Fetching a batch re-applies a narrower deny list for that agent; once every deferred tool has been fetched the restriction is dropped entirely.'}</p>
        <p><strong>{isZh ? '3. 始终常驻的那几个' : '3. The handful that never defer'}</strong><br />{isZh
          ? 'tool_search 本身必须常驻（否则就是把自己锁在门外）；工程状态、仓库地图是「什么都不对时用户第一个点的东西」；advisor_review 和 headroom_retrieve 是模型已经被提示过要去用的工具（一条建议、一个压缩标记里的 hash），让它们再多走一次发现流程只是纯延迟。'
          : 'tool_search itself must stay (deferring it would be a lockout); engineering status and the repo map are what a user reaches for when nothing else works; advisor_review and headroom_retrieve answer something the model has already been shown (a hint to consult the advisor, a hash inside a compression marker), so a discovery round-trip there is pure latency.'}</p>
      </div>
    </details>
  </section>
}

/** Show newly detected Host-side plugin repairs above every application view. */
export function GuardSettingsPanel(input: {
  readonly status?: (() => Promise<RemoteResult<FreeCodeGoGuardSettingsStatus>>) | undefined
  readonly update?: ((patch: FreeCodeGoGuardSettingsUpdate) => Promise<RemoteResult<FreeCodeGoGuardSettingsStatus>>) | undefined
  readonly language: 'zh' | 'en'
}): ReactNode {
  const isZh = input.language === 'zh'
  const [snapshot, setSnapshot] = useState<FreeCodeGoGuardSettingsStatus | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const refresh = (): void => {
    if (input.status === undefined) return
    void input.status().then((result) => { if (result.ok) setSnapshot(result.value) }).catch(() => undefined)
  }
  useEffect(() => { refresh() }, [input.status])
  const toggle = (patch: FreeCodeGoGuardSettingsUpdate): void => {
    if (input.update === undefined) return
    setBusy(true)
    void input.update(patch).then((result) => { if (result.ok) setSnapshot(result.value); else refresh() }).catch(() => { refresh() }).finally(() => { setBusy(false) })
  }
  const row = (key: keyof FreeCodeGoGuardSettingsUpdate, title: string, hint: string): ReactNode => {
    const value = snapshot === undefined ? undefined : snapshot[key]
    return <label className={css.extensionRow} key={key}><span><strong>{title}</strong><small>{hint}</small></span><input className={css.switch} aria-label={title} type="checkbox" checked={value === true} onChange={(event) => { toggle({ [key]: event.target.checked }) }} disabled={input.update === undefined || busy || value === undefined} /></label>
  }
  const lsp = snapshot?.lsp
  return <section className={css.section}>
    <div className={css.sectionHeader}><div><div className={css.kicker}>GUARDS</div><strong className={css.sectionName}>{isZh ? '安全守卫与质量增强' : 'Guards and quality enhancements'}</strong></div></div>
    <small className={css.sectionMeta}>{isZh
      ? '主机级安全与质量开关：对所有引擎的 Host 工具调用生效，多数默认开启，个别为可选增强。'
      : 'Host-level safety and quality toggles: applied to Host tool dispatch for every engine. Most are on by default; a few are opt-in enhancements.'}</small>
    <div className={css.extensionList}>
      {row('envReadGuardEnabled', isZh ? '凭证文件读取保护' : 'Credential-file read protection', isZh ? '拒绝读取 .env、SSH 密钥、云凭证等机密文件；模型会被引导向用户索要所需值。' : 'Denies reads of .env, SSH keys, cloud credentials, and similar secrets; the model is told to ask you for values instead.')}
      {row('doomLoopGuardEnabled', isZh ? '死循环守卫' : 'Doom-loop guard', isZh ? '同一工具调用 10 分钟内完全相同地重复 3 次即阻断并冷却 2 分钟，防止失控引擎烧 token。只针对 Codex/Claude 等原生引擎自己的工具：经 Host 分发的工具调用由 Harness 自带的重复提醒负责，本守卫不再重复裁决。' : 'Blocks the 3rd identical tool call within 10 minutes (2-minute cooldown), stopping runaway engines from burning tokens. Native engines\' own tools only: calls the Host dispatches are the Harness\'s own repeat-reminder to judge, which this guard no longer second-guesses.')}
      {row('assistantLoopGuardEnabled', isZh ? '助手输出循环守卫' : 'Assistant-output loop guard', isZh ? '在回答流式生成时就检测模型陷在自己的文字里打转——同一行、同一列表格行或同一段落一直重复到窗口耗尽。第一次检测注入提醒并让本回合继续，再次检测即取消本回合，因为被提醒后仍重复的输出不会自行收敛，而每个多余 token 都要付两次账。工具调用的重复由「死循环守卫」负责，不是这里。' : 'Watches the answer while it is still streaming and acts on the model looping inside its own prose — the same line, table row, or paragraph until the window is gone. The first detection injects a reminder and lets the turn continue; a second one cancels it, because text repeated after a warning will not converge on its own and every further token is paid for twice. Repetition across tool calls belongs to the doom-loop guard, not here.')}
      {row('lspEnabled', isZh ? 'LSP 语言服务' : 'LSP language services', isZh ? '探测到 TypeScript/Python/Go 语言服务器时自动挂载精准跳转/引用工具。' : 'Mounts precise definition/reference tools when TypeScript/Python/Go language servers are detected on PATH.')}
      {row('rehydrationEnabled', isZh ? '压缩后再水化' : 'Post-compaction rehydration', isZh ? '上下文压缩完成后自动重新注入任务计划与长期记忆，会话不“失忆”。' : 'After compaction, re-injects the task plan and durable memory so the session keeps its plan.')}
      {row('rehydrationArcEnabled', isZh ? '会话弧段（目标与决策）' : 'Conversation arc (goals and decisions)', isZh ? '压缩后再水化时，先从会话日志与项目记忆中折叠出这段对话的目标与已定决策并置于最前，让复活后的上下文先回到「要做什么、已经定了什么」，而不是先看到待办清单。可选增强，默认关闭：折叠需要读整段会话事件。' : 'On post-compaction rehydration, first fold this conversation\'s goals and decisions out of the session log and project memory and put them at the front, so the revived context returns to what this is for and what was already decided before it sees the todo list. An opt-in enhancement, off by default: folding reads the whole session event log.')}
      {row('advisorMemoryDraftsEnabled', isZh ? 'Advisor 发现存入记忆' : 'Advisor findings to memory', isZh ? 'Advisor 复核发现自动存为项目记忆草稿，供你在记忆面板审阅。' : 'Advisor review findings are saved as pending project-memory drafts for your review.')}
      {row('commandPolicyEnabled', isZh ? '命令策略（拒绝性规则）' : 'Command policy (refusals)', isZh ? '规则写在插件里、自带正反例，加载时逐条自测：规则谎报自己能匹配什么就会被丢弃。只有“forbidden”会在此处直接阻断；需要询问的命令交给审批层，因为守卫无法把它变回一次询问。' : 'Rules live in the plugin as data with their own positive and negative examples, validated at load time: a rule that misstates what it matches is dropped. Only `forbidden` blocks here; commands that warrant a question are left to the approval layer, because a monotonic guard cannot turn a denial back into a prompt.')}
      {row('planModeEnabled', isZh ? '计划模式（结构性禁止写入）' : 'Plan Mode (structural write refusal)', isZh ? '开启后模型可进入计划模式：改文件的工具与策略未放行的命令都会被拒绝，而读取、搜索、跑测试仍然可用。模式属于这段对话，不会因为一句祈使句而结束，退出必须显式调用工具。' : 'Lets the model enter Plan Mode: file-mutating tools and any command the policy does not clear are refused, while reading, searching, and running checks stay available. The mode belongs to the conversation, does not end because a sentence asked for execution, and only ends through an explicit tool call.')}
      {row('cacheColdClearEnabled', isZh ? '冷缓存清理' : 'Cache-cold clearing', isZh ? '当距上一条主循环消息的间隔超过 1 小时（供应商的 prompt 缓存必然已过期）时，在发起下一次请求之前清掉较早的工具结果。理由不是“内容变旧”，而是这部分前缀横竖都要被重写，提前清掉正好减小那次必然发生的重算；判断阈值取 1 小时，所以它不会制造一次本来不会发生的缓存未命中。清除标记只在本次会话内维护，同一段内容不会被重复处理。' : 'When more than an hour has passed since the last main-loop message (so the provider\'s prompt cache has certainly expired), older tool results are cleared **before** the next request is made. The reason is not that the content is old: that prefix is going to be rewritten anyway, so shrinking it beforehand reduces a re-billing that is already certain. The one-hour threshold is deliberately past every published TTL, so this can never cause a cache miss that would not have happened. Clear markers are tracked per session, so the same content is never processed twice.')}
      {row('cacheBreakAttributionEnabled', isZh ? '缓存失效归因' : 'Cache-break attribution', isZh ? '每次请求前给请求形状（系统提示、工具定义、逐工具 schema、模型、附件、预算档）录一次指纹，与上一轮对比，并把随后 cache read 的下降归因到具体变化上：是模型换了、空闲超时，还是某个工具的描述改了。工具描述总长不变、只有某个工具的描述变了这种情况会被单独点名，因为它占实际缓存失效的绝大多数；一轮里写入日志，预算面板里汇总显示。' : 'Fingerprints the request shape before each request — system prompt, tool definitions, per-tool schemas, model, betas, budget band — diffs it against the previous turn, and attributes the following drop in cache reads to a named cause: a model switch, an idle gap past the TTL, or a specific tool whose description moved. The case where the tool *set* is unchanged but one description changed is called out separately, because it dominates real cache breaks. Diff lines are logged per turn and the waste is summarised in the budget panel.')}
      {row('contextBudgetEnabled', isZh ? '上下文预算提示' : 'Model-visible context budget', isZh ? '每回合结束后告诉模型它的上下文占用：已用 token、模型窗口、以及为回复预留后还剩多少。文案按档位量化（充裕 / 舒适 / 紧张 / 临界 / 超出），所以同一档位内不会改写前缀，缓存不受影响；模型也可随时调用 engineering_context_budget 取精确值。估计值会标注为估计，未公布窗口的模型只报已用量、不编造分母。' : 'After each turn the model is told its context pressure: tokens in use, the model window, and what is left after a reply reserve. The text is quantized into bands (ample / comfortable / tight / critical / over), so the prefix is not rewritten within a band and the cache is untouched; the model can also call engineering_context_budget for exact figures. Estimates are labelled as estimates, and a model that advertises no window gets the used figure with no invented denominator.')}
      {row('promptCompositionEnabled', isZh ? '提示词构成明细' : 'Prompt composition breakdown', isZh ? '允许模型调用 engineering_context_prompt 查看 prompt token 实际花在哪里——系统提示、工具定义、规则、Skills、MCP 服务器、子 Agent 定义、已总结对话、逐字记录——并点名占用最大的单项与从未返回结果的工具调用对。关闭后模型只剩压力数字（engineering_context_budget），拿不到明细，也就无法判断该精简哪一块。' : 'Lets the model call engineering_context_prompt to see where its prompt tokens actually go — system prompt, tool definitions, rules, Skills, MCP servers, subagent definitions, summarized conversation, transcript — naming the largest individual items and any tool call whose result never arrived. Turned off, the model keeps only the pressure figure (engineering_context_budget) and loses the breakdown, so it cannot tell which block to shrink.')}
      {lsp === undefined ? null : <div className={css.accountList}>{lsp.servers.map(server => <div className={css.accountRow} key={server.id}><div className={css.accountIdentity}><strong className={css.accountName}>{isZh ? `语言服务器 · ${server.id}` : `Language server · ${server.id}`}</strong></div><span className={`${css.badge} ${server.available ? css.badgeLive : ''}`}>{server.available ? (isZh ? '已探测' : 'Detected') : (isZh ? '未安装' : 'Not installed')}</span></div>)}{lsp.error === undefined ? null : <div className={css.accountRow}><div className={css.accountIdentity}><small>{lsp.error}</small></div></div>}</div>}
    </div>
  </section>
}

/**
 * The four session-automation switches.
 *
 * Rendered because a Remote nobody calls is not a control. These four were
 * declared in the settings schema, read by the automation runtime, and named in
 * `freecodego_schedule_plan`'s refusal message, while no surface could change
 * one: failure recovery could not be switched off, its loop guards could not be
 * widened, and the calendar planner could not be turned off. The panel reads
 * `automationSettingsStatus` on mount instead of assuming a default, because the
 * runtime falls back field by field — a partial or hand-edited settings document
 * would otherwise be displayed as if it were the policy.
 */
export function AutomationSettingsPanel(input: {
  readonly status?: (() => Promise<RemoteResult<FreeCodeGoAutomationSettings>>) | undefined
  readonly update?: ((patch: FreeCodeGoAutomationSettingsUpdate) => Promise<RemoteResult<FreeCodeGoAutomationSettings>>) | undefined
  readonly language: 'zh' | 'en'
}): ReactNode {
  const isZh = input.language === 'zh'
  const [snapshot, setSnapshot] = useState<FreeCodeGoAutomationSettings | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const refresh = (): void => {
    if (input.status === undefined) return
    void input.status().then((result) => { if (result.ok) setSnapshot(result.value) }).catch(() => undefined)
  }
  useEffect(() => { refresh() }, [input.status])
  // A refusal is reported and the read is repeated, because the settings schema
  // owns the bounds: an out-of-range value is refused with the schema's own
  // message, and re-reading is what shows the user the value still in force.
  const apply = (patch: FreeCodeGoAutomationSettingsUpdate): void => {
    if (input.update === undefined) return
    setBusy(true)
    setError(undefined)
    void input.update(patch).then((result) => {
      if (result.ok) setSnapshot(result.value)
      else { setError(result.error.message); refresh() }
    }).catch(() => { refresh() }).finally(() => { setBusy(false) })
  }
  const toggle = (key: 'hookChainsEnabled' | 'scheduledTasksEnabled', title: string, hint: string): ReactNode => {
    const value = snapshot === undefined ? undefined : snapshot[key]
    return <label className={css.extensionRow} key={key}><span><strong>{title}</strong><small>{hint}</small></span><input className={css.switch} aria-label={title} type="checkbox" checked={value === true} onChange={(event) => { apply({ [key]: event.target.checked }) }} disabled={input.update === undefined || busy || value === undefined} /></label>
  }
  /**
   * One numeric switch, displayed at `scale` (milliseconds are shown as
   * seconds). Only `min`/`max`/`step` come from the schema's vocabulary — the
   * bounds themselves stay Host-side, so this input constrains the picker
   * without becoming a second copy of the numbers that are already validated.
   */
  const number = (key: 'hookChainsMaxDepth' | 'hookChainsCooldownMs', title: string, hint: string, bounds: { readonly min: number; readonly max: number; readonly step: number; readonly scale: number }): ReactNode => {
    const value = snapshot === undefined ? undefined : snapshot[key]
    return <label className={css.extensionRow} key={key}><span><strong>{title}</strong><small>{hint}</small></span><input className={css.input} aria-label={title} type="number" min={bounds.min / bounds.scale} max={bounds.max / bounds.scale} step={bounds.step / bounds.scale} value={value === undefined ? '' : String(value / bounds.scale)} onChange={(event) => {
      // An emptied field is not a zero: `Number('')` is 0, which would commit a
      // value the user was halfway through replacing.
      const text = event.target.value.trim()
      if (text === '') return
      const parsed = Number(text)
      if (!Number.isFinite(parsed)) return
      apply({ [key]: Math.round(parsed * bounds.scale) })
    }} disabled={input.update === undefined || busy || value === undefined} style={{ maxWidth: '120px' }} /></label>
  }
  return <section className={css.section}>
    <div className={css.sectionHeader}><div><div className={css.kicker}>AUTOMATION</div><strong className={css.sectionName}>{isZh ? '会话自动化' : 'Session automation'}</strong></div></div>
    <small className={css.sectionMeta}>{isZh
      ? '失败自愈规则与日历提醒的闸门。规则文件属于项目（`.freecodego/hook-chains.json`），这里只控制它们是否生效；两个开关默认都是开启。'
      : 'The gates on failure-recovery rules and calendar planning. The rule file belongs to the project (`.freecodego/hook-chains.json`); these switches only decide whether it takes effect. Both default to on.'}</small>
    {error === undefined ? null : <div className={css.alert} role="alert">{isZh ? `设置未能生效：${error}` : `The setting did not take effect: ${error}`}</div>}
    <div className={css.extensionList}>
      {toggle('hookChainsEnabled', isZh ? '失败自愈规则' : 'Failure-recovery rules', isZh ? '工具失败后按项目里的规则派发恢复动作（通知团队、换引擎重试等）。关闭后规则文件不再被读取。' : 'On a tool failure, dispatch the recovery actions declared in the project file (notify the team, retry on another engine). Turning this off stops the file from being read at all.')}
      {number('hookChainsMaxDepth', isZh ? '自愈链最大深度' : 'Deepest recovery chain', isZh ? '一条规则最多能再触发多少层规则，默认 2，范围 0–10。深度会覆盖规则文件里的写法：文件不能把闸门放宽。' : 'How many further rules one rule may trigger, default 2, range 0–10. This caps the project file rather than deferring to it: a file cannot widen the guard.', { min: 0, max: 10, step: 1, scale: 1 })}
      {number('hookChainsCooldownMs', isZh ? '自愈冷却（秒）' : 'Recovery cooldown (seconds)', isZh ? '同一自愈事件再次触发前的最短等待，默认 30 秒，范围 0–86400。同样由设置覆盖规则文件。' : 'Shortest wait before an identical recovery event may fire again, default 30 s, range 0–86400. Settings override the file here too.', { min: 0, max: 24 * 60 * 60 * 1_000, step: 1_000, scale: 1_000 })}
      {toggle('scheduledTasksEnabled', isZh ? '日历提醒规划' : 'Calendar planning', isZh ? '允许把 cron 表达式换算成 Harness 的提醒选择器。关闭后 `freecodego_schedule_plan` 会直接拒绝。提醒本身始终由 Harness 保存，插件不存第二份。' : 'Lets a cron expression be converted into Harness reminder selectors. Turning this off makes `freecodego_schedule_plan` refuse outright. The reminder itself is always stored by Harness; this plugin keeps no second copy.')}
    </div>
  </section>
}

/**
 * The session's file-sandbox mode.
 *
 * The Host built `sandboxModeStatus` / `sandboxModeSet` precisely because the
 * stock client has no surface for the policy, and then no surface rendered them:
 * the mode the engines actually run under was unreadable and unchangeable. It is
 * shown here with the deployment default alongside, because the mode in force is
 * `override ?? defaultMode` and a user comparing two sessions needs to see which
 * of the two is speaking.
 */
export function SandboxModePanel(input: {
  readonly sessionId?: string | undefined
  readonly status?: ((sessionId: string) => Promise<RemoteResult<FreeCodeGoSandboxStatus>>) | undefined
  readonly setMode?: ((sessionId: string, mode: FreeCodeGoSandboxMode) => Promise<RemoteResult<FreeCodeGoSandboxStatus>>) | undefined
  readonly language: 'zh' | 'en'
}): ReactNode {
  const isZh = input.language === 'zh'
  const [snapshot, setSnapshot] = useState<FreeCodeGoSandboxStatus | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const sessionId = input.sessionId
  const refresh = (): void => {
    if (input.status === undefined || sessionId === undefined) return
    void input.status(sessionId).then((result) => {
      if (result.ok) { setSnapshot(result.value); setLoadError(undefined); return }
      // A failed read is not "still loading": without this the panel stays on
      // its empty state forever and the user never learns why.
      setLoadError(result.error.message)
    }).catch((reason: unknown) => { setLoadError(reason instanceof Error ? reason.message : String(reason)) })
  }
  useEffect(() => { setSnapshot(undefined); setLoadError(undefined); refresh() }, [input.status, sessionId])
  const choose = (mode: FreeCodeGoSandboxMode): void => {
    if (input.setMode === undefined || sessionId === undefined) return
    setBusy(true)
    setError(undefined)
    void input.setMode(sessionId, mode).then((result) => {
      if (result.ok) setSnapshot(result.value)
      else setError(result.error.message)
    }).catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  if (sessionId === undefined || input.status === undefined) return null
  const options: readonly { readonly mode: FreeCodeGoSandboxMode; readonly title: string; readonly hint: string }[] = [
    { mode: 'read-only', title: isZh ? '只读' : 'Read-only', hint: isZh ? '改文件的工具与原生引擎的写入/命令都会被拒绝，读取、检索与只读命令照常可用。' : 'File-mutating tools and the native engines\' writes and commands are refused; reading, searching, and read-only commands stay available.' },
    { mode: 'workspace-write', title: isZh ? '仅工作区可写' : 'Workspace write', hint: isZh ? '允许在会话工作区内写入，越界写入仍走向你询问的审批。原生引擎有自己的同类模式，直接按此启动。' : 'Writes inside the session workspace are allowed; anything outside still goes through an approval prompt. The native engines have a mode of the same name and start in it.' },
    { mode: 'danger-full-access', title: isZh ? '完全放开（有风险）' : 'Full access (risky)', hint: isZh ? '不再限制路径：原生引擎可以写工作区之外的任何位置。只在确实需要时选它。' : 'No path restriction at all: the native engines may write anywhere outside the workspace. Choose it only when the task genuinely needs that.' },
  ]
  const mode = snapshot?.mode
  return <section className={css.section}>
    <div className={css.sectionHeader}><div><div className={css.kicker}>SANDBOX</div><strong className={css.sectionName}>{isZh ? '文件沙箱模式' : 'File sandbox mode'}</strong></div>{snapshot === undefined ? null : <span className={`${css.badge} ${snapshot.live ? css.badgeLive : ''}`}>{snapshot.live ? (isZh ? '会话进行中' : 'Session live') : (isZh ? '会话已结束' : 'Session closed')}</span>}</div>
    <small className={css.sectionMeta}>{isZh
      ? '本会话的沙箱策略由 Harness 持有，插件只代为显示与切换。改动写入一条 `sandbox/mode` 事件，因此它随会话持久化、可重放，并且只影响这一段会话。原生引擎在开启引擎会话时读取它，所以改动从下一段引擎会话开始生效，而不是追溯收紧正在跑的那一段。'
      : 'Harness owns this session\'s sandbox policy; the plugin only shows it and switches it. A change appends one `sandbox/mode` event, so it is durable, replay-safe, and scoped to this conversation. The native engines read it when they open their engine session, so a change takes effect from the next engine session rather than retroactively tightening the running one.'}</small>
    {error === undefined ? null : <div className={css.alert} role="alert">{isZh ? `模式未能切换：${error}` : `The mode was not switched: ${error}`}</div>}
    {loadError === undefined ? null : <div className={css.alert} role="alert">{isZh ? `沙箱状态读取失败：${loadError}` : `Could not read the sandbox status: ${loadError}`}</div>}
    <div className={css.extensionList}>
      {options.map(option => <div className={css.extensionRow} key={option.mode}><span><strong>{option.title}{mode === option.mode ? (isZh ? '（当前）' : ' (current)') : ''}</strong><small>{option.hint}</small></span><button className={css.button} type="button" aria-label={`sandbox-mode-${option.mode}`} onClick={() => { choose(option.mode) }} disabled={input.setMode === undefined || busy || snapshot === undefined || !snapshot.live || mode === option.mode}>{mode === option.mode ? (isZh ? '已启用' : 'In use') : (isZh ? '切换到此模式' : 'Switch to this mode')}</button></div>)}
      {snapshot === undefined ? null : <div className={css.accountRow}><div className={css.accountIdentity}><strong className={css.accountName}>{isZh ? '部署默认' : 'Deployment default'}</strong><small>{snapshot.defaultMode}{snapshot.override === undefined ? (isZh ? ' · 本会话尚未自行选择，因此沿用默认' : ' · this session has made no choice of its own, so the default applies') : (isZh ? ` · 本会话已显式选择 ${snapshot.override}` : ` · this session chose ${snapshot.override} explicitly`)}{snapshot.workspaceRoot === undefined ? '' : (isZh ? ` · 可写目录 ${snapshot.workspaceRoot}` : ` · writable root ${snapshot.workspaceRoot}`)}</small></div></div>}
      {snapshot === undefined || snapshot.live ? null : <div className={css.accountRow}><div className={css.accountIdentity}><small>{isZh ? '会话已结束，模式无法再切换；这里显示的是它留下的持久选择。' : 'The session has closed, so its mode can no longer be switched; this is the durable choice it left behind.'}</small></div></div>}
    </div>
  </section>
}

/**
 * Folder trust, as a panel.
 *
 * The gate decides what a repository may contribute — project MCP servers, Skill
 * roots, hooks — and it is fail-closed. That makes the record a thing the user has
 * to be able to *read*: a workspace that silently stopped loading its servers is
 * indistinguishable from one that never had any, and the record lives outside the
 * workspace precisely so the repository cannot grant itself. This panel is where
 * it becomes visible and revocable.
 */
export function TrustPanel(input: {
  readonly status?: (() => Promise<RemoteResult<FreeCodeGoTrustStatus>>) | undefined
  readonly grant?: ((directory: string) => Promise<RemoteResult<FreeCodeGoTrustStatus>>) | undefined
  readonly revoke?: ((directory: string) => Promise<RemoteResult<FreeCodeGoTrustStatus>>) | undefined
  readonly projectConfig?: ((workspaceRoot?: string) => Promise<RemoteResult<ProjectConfigReport>>) | undefined
  readonly language: 'zh' | 'en'
}): ReactNode {
  const isZh = input.language === 'zh'
  const [snapshot, setSnapshot] = useState<FreeCodeGoTrustStatus | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  // The project tier is the other half of the same question. Trust says whether
  // the repository's own content may be mounted; this says what the repository
  // actually asked for, and — the half a repository author needs — which keys it
  // wrote that the tier does not accept. Showing only trust would leave them with
  // "granted" and still nothing happening.
  const [projectConfig, setProjectConfig] = useState<ProjectConfigReport | undefined>(undefined)
  const [statusError, setStatusError] = useState<string | undefined>(undefined)
  const [projectError, setProjectError] = useState<string | undefined>(undefined)
  const refresh = (): void => {
    if (input.status === undefined) return
    void input.status().then((result) => {
      if (result.ok) { setSnapshot(result.value); setStatusError(undefined); return }
      // The badge reads `snapshot`, so a swallowed failure would leave it saying
      // "Loading" forever with no way to tell a slow Host from a broken one.
      setStatusError(result.error.message)
    }).catch((reason: unknown) => { setStatusError(reason instanceof Error ? reason.message : String(reason)) })
  }
  const refreshProjectConfig = (): void => {
    if (input.projectConfig === undefined) return
    void input.projectConfig().then((result) => {
      if (result.ok) { setProjectConfig(result.value); setProjectError(undefined); return }
      setProjectError(result.error.message)
    }).catch((reason: unknown) => { setProjectError(reason instanceof Error ? reason.message : String(reason)) })
  }
  useEffect(() => { refresh(); refreshProjectConfig() }, [input.status, input.projectConfig])
  const act = (run: () => Promise<RemoteResult<FreeCodeGoTrustStatus>>): void => {
    setBusy(true)
    setError(undefined)
    void run().then((result) => {
      if (result.ok) setSnapshot(result.value)
      else setError(result.error.message)
      // The report carries the gate's answer, so a grant or a revoke changes it
      // even though no file moved. The Host drops its cached copy on the same
      // transition; this is the surface asking for the new one.
      refreshProjectConfig()
    }).catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setBusy(false) })
  }
  if (input.status === undefined) return null
  const current = snapshot?.current
  const root = snapshot?.currentRoot
  const trusted = current?.trusted === true
  const acceptedKeys = projectConfig === undefined ? [] : Object.keys(projectConfig.accepted)
  const reasonText = (reason: string): string => {
    if (reason === 'granted') return isZh ? '已授信：此仓库可以加载项目级 MCP、Skill 根与 hooks。' : 'Granted: this repository may contribute project MCP servers, Skill roots, and hooks.'
    if (reason === 'no-record') return isZh ? '未授信：记录里没有这个仓库。项目级资源会被跳过，并在日志里留一条提示。' : 'Not trusted: the record does not name this repository. Project-scoped resources are skipped with one warning in the log.'
    if (reason === 'revoked') return isZh ? '已撤销：此前授信过，现已撤回。' : 'Revoked: this repository was granted before and has since been withdrawn.'
    if (reason === 'global-disabled') return isZh ? '门禁已全局关闭：五处消费点都不再检查授信。' : 'The gate is disabled globally: neither consumer checks trust at all.'
    if (reason === 'not-a-repository') return isZh ? '不在任何 git 仓库内，因此没有可授信的单位。' : 'Not inside a git repository, so there is no unit of trust to name.'
    return reason
  }
  return <section className={css.section}>
    <div className={css.sectionHeader}><div><div className={css.kicker}>TRUST</div><strong className={css.sectionName}>{isZh ? '文件夹授信' : 'Folder trust'}</strong></div><span className={`${css.badge} ${trusted ? css.badgeLive : ''}`}>{snapshot === undefined ? (statusError === undefined ? (isZh ? '读取中' : 'Loading') : (isZh ? '读取失败' : 'Read failed')) : ! snapshot.enabled ? (isZh ? '门禁已关闭' : 'Gate off') : trusted ? (isZh ? '已授信' : 'Trusted') : (isZh ? '未授信' : 'Not trusted')}</span></div>
    <small className={css.sectionMeta}>{isZh
      ? '授信按 **git 仓库根**记账，不按目录前缀；嵌套的 checkout 是独立工作区。记录写在环境目录下而不是工作区内，所以仓库无法给自己授信。撤销立即生效，并在下一次挂载时重算项目级资源。'
      : 'Trust is recorded per **git repository root**, not per path prefix, and a nested checkout is its own workspace. The record lives under the environment directory rather than inside the workspace, so a repository cannot grant itself. A revoke takes effect immediately and recomputes project-scoped resources on the next mount.'}</small>
    {error === undefined ? null : <div className={css.alert} role="alert">{isZh ? `授信未更改：${error}` : `Trust was not changed: ${error}`}</div>}
    {statusError === undefined ? null : <div className={css.alert} role="alert">{isZh ? `授信状态读取失败：${statusError}` : `Could not read the trust status: ${statusError}`}</div>}
    {projectError === undefined ? null : <div className={css.alert} role="alert">{isZh ? `项目级配置读取失败：${projectError}` : `Could not read the project configuration: ${projectError}`}</div>}
    <div className={css.extensionList}>
      <div className={css.extensionRow}><span><strong>{isZh ? '当前工作区' : 'Current workspace'}</strong><small>{root === undefined ? (isZh ? 'Host 无法解析出仓库根' : 'the Host could not resolve a repository root') : `${root}${current === undefined ? '' : ` · ${reasonText(current.reason)}`}`}</small></span>
        {root === undefined || snapshot?.enabled === false ? null : <button className={css.button} type="button" aria-label="trust-current-toggle" onClick={() => { if (root === undefined) return; if (trusted) { if (input.revoke !== undefined) act(() => input.revoke!(root)) } else if (input.grant !== undefined) act(() => input.grant!(root)) }} disabled={busy || input.grant === undefined || input.revoke === undefined}>{trusted ? (isZh ? '撤销授信' : 'Revoke trust') : (isZh ? '授信此仓库' : 'Trust this repository')}</button>}
      </div>
      {snapshot === undefined ? null : <div className={css.accountRow}><div className={css.accountIdentity}><strong className={css.accountName}>{isZh ? '授信记录' : 'Grant record'}</strong><small>{snapshot.entries.length === 0 ? (isZh ? '（空）' : '(empty)') : `${snapshot.entries.length} · ${snapshot.recordPath}`}</small></div></div>}
      {snapshot?.entries.map(entry => <div className={css.accountRow} key={entry.root}><div className={css.accountIdentity}><strong className={css.accountName}>{entry.root}</strong><small>{entry.grantedAt}</small></div><button className={css.button} type="button" aria-label={`trust-revoke-${entry.root}`} onClick={() => { if (input.revoke !== undefined) act(() => input.revoke!(entry.root)) }} disabled={busy || input.revoke === undefined}>{isZh ? '撤销' : 'Revoke'}</button></div>)}
      {projectConfig === undefined ? null : <>
        <div className={css.accountRow}><div className={css.accountIdentity}>
          <strong className={css.accountName}>{isZh ? '项目级配置' : 'Project configuration'}</strong>
          <small>{isZh
            ? `仓库可以在 ${projectConfig.path} 里声明：${projectConfig.whitelist.join('、')}。其他键会被忽略，并在此逐条列出。`
            : `A repository may declare ${projectConfig.whitelist.join(', ')} in ${projectConfig.path}. Every other key is ignored, and named here.`}</small>
        </div></div>
        {projectConfig.note === undefined ? null : <div className={css.alert} role="alert">{projectConfig.note}</div>}
        <div className={css.accountRow}><div className={css.accountIdentity}>
          <strong className={css.accountName}>{isZh ? '已生效' : 'In effect'}</strong>
          <small aria-label="project-config-accepted">{acceptedKeys.length === 0
            ? (isZh ? '（此仓库没有声明任何受支持的键）' : '(this repository declares no supported key)')
            : acceptedKeys.join('、')}</small>
        </div></div>
        {projectConfig.ignored.length === 0 ? null : <div className={css.accountRow}><div className={css.accountIdentity}>
          <strong className={css.accountName}>{isZh ? '已忽略' : 'Ignored'}</strong>
          <small aria-label="project-config-ignored">{isZh
            ? `${projectConfig.ignored.join('、')} —— 不在白名单内，项目层不接受这些键。白名单故意不可配置：一个能改宽它的设置，就是同一个风险换了一层。`
            : `${projectConfig.ignored.join(', ')} — outside the whitelist, so this tier does not accept them. The whitelist is deliberately not configurable: a setting that could widen it is the same hazard one indirection away.`}</small>
        </div></div>}
      </>}
    </div>
  </section>
}

export function PluginConflictNotice(input: {
  readonly status: Injected['pluginConflictStatus']
}): ReactNode {
  const [dialog, setDialog] = useState<FreeCodeGoPluginConflictStatus['pluginConflictRecords'][number] | undefined>(undefined)
  const seen = useRef(new Set<string>())
  useEffect(() => {
    const status = input.status
    if (status === undefined) return
    let active = true
    let requestGeneration = 0
    const refresh = (): void => {
      const generation = ++requestGeneration
      void status().then((result) => {
        if (!active || generation !== requestGeneration || !result.ok) return
        const cutoff = Date.now() - CONFLICT_NOTICE_MAX_AGE_MS
        for (const record of result.value.pluginConflictRecords) {
          if (record.detectedAt < cutoff) seen.current.add(record.id)
        }
        const latest = result.value.pluginConflictRecords
          .filter(record => record.detectedAt >= cutoff && !seen.current.has(record.id)
            // A record the running tree no longer matches describes a state the
            // Harness has since left: announcing it as a fresh repair would be a
            // notification about a plugin that is running right now.
            && (result.value.pluginConflictActiveRecords ?? []).includes(record.id))
          .at(-1)
        if (latest === undefined) return
        seen.current.add(latest.id)
        setDialog(latest)
      }, () => {})
    }
    refresh()
    const timer = window.setInterval(() => {
      // Skip the Host round-trip entirely for background tabs; the next visible
      // tick picks the notice up again within 30 seconds.
      if (document.visibilityState === 'hidden') return
      refresh()
    }, 30_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [input.status])
  return <Modal open={dialog !== undefined} onClose={() => { setDialog(undefined) }} title="插件冲突已自动修复" closeLabel="关闭">
    {dialog === undefined ? null : <><p>已保留插件：<code>{dialog.keptModuleName}</code></p><p>已停用冲突条目：<code>{dialog.disabledModuleName}</code></p><p>冲突资源：<code>{dialog.resource}：{dialog.resourceName}</code></p><small className={css.sectionMeta}>该处理避免重复注册导致 DeepSeek Harness 启动失败。可在 FreeCodeGo 设置页查看最近的自动修复记录。</small></>}
  </Modal>
}

function CapabilitySettingsPage(input: {
  readonly snapshot: CapabilitySnapshot | undefined
  readonly setEnabled: Injected['capabilitiesSetEnabled']
  readonly setLocalCapability: Injected['setLocalCapability']
  readonly onSnapshot: (value: CapabilitySnapshot) => void
  readonly onError: (message: string) => void
}): ReactNode {
  const snapshot = input.snapshot
  const update = (patch: { readonly mcpEnabled?: boolean; readonly skillEnabled?: boolean; readonly voiceInputEnabled?: boolean; readonly sessionDeleteEnabled?: boolean }): void => {
    const before = snapshot
    // Optimistic update first so the switch reacts immediately.
    if (snapshot !== undefined) input.onSnapshot({ ...snapshot, ...patch })
    // The Host capability call is the primary path: it projects the switch to
    // DeepSeek, Claude Agent SDK, and Codex app-server in one snapshot. The
    // local settings write is only a fallback for older Remote descriptors
    // that never exposed capabilitiesSetEnabled.
    if (input.setEnabled !== undefined) {
      void input.setEnabled(patch).then((result) => {
        if (result.ok) { input.onSnapshot(result.value); return }
        if (before !== undefined) input.onSnapshot(before)
        input.onError(result.error.message)
      }, (error: unknown) => { if (before !== undefined) input.onSnapshot(before); input.onError(error instanceof Error ? error.message : String(error)) })
      return
    }
    const localEntry = patch.voiceInputEnabled === undefined
      ? patch.sessionDeleteEnabled === undefined ? undefined : ['sessionDeleteEnabled', patch.sessionDeleteEnabled] as const
      : ['voiceInputEnabled', patch.voiceInputEnabled] as const
    if (localEntry === undefined || input.setLocalCapability === undefined) return
    void input.setLocalCapability(localEntry[0], localEntry[1]).catch((error: unknown) => {
      if (before !== undefined) input.onSnapshot(before)
      input.onError(error instanceof Error ? error.message : String(error))
    })
  }
  return <section className={css.section}>
    <div className={css.sectionHeader}><div><div className={css.kicker}>Extensions</div><strong className={css.sectionName}>MCP 与 Skill</strong></div><span className={css.badge}>统一能力层</span></div>
    <small className={css.sectionMeta}>启用后会显示对应入口，并把同一配置投射给 DeepSeek、Claude Agent SDK 和 Codex app-server。现有会话在下一次新建会话时获得完整能力快照。</small>
    <div className={css.extensionList}>
      <label className={css.extensionRow}><span><strong>MCP</strong><small>连接第三方 stdio 或 Streamable HTTP MCP 服务。</small></span><input className={css.switch} aria-label="MCP" type="checkbox" checked={snapshot?.mcpEnabled === true} onChange={(event) => { update({ mcpEnabled: event.target.checked }) }} disabled={input.setEnabled === undefined} /></label>
      <label className={css.extensionRow}><span><strong>Skill</strong><small>向三个 Agent 引擎提供统一的 Skill 目录和按需加载能力。</small></span><input className={css.switch} aria-label="Skill" type="checkbox" checked={snapshot?.skillEnabled === true} onChange={(event) => { update({ skillEnabled: event.target.checked }) }} disabled={input.setEnabled === undefined} /></label>
      <label className={css.extensionRow}><span><strong>语音输入</strong><small>在输入框显示话筒，录音完成后转写为草稿文字。</small></span><input className={css.switch} aria-label="语音输入" type="checkbox" checked={snapshot?.voiceInputEnabled !== false} onChange={(event) => { update({ voiceInputEnabled: event.target.checked }) }} disabled={input.setEnabled === undefined && input.setLocalCapability === undefined} /></label>
      <label className={css.extensionRow}><span><strong>会话删除</strong><small>在会话悬停时显示删除按钮。</small></span><input className={css.switch} aria-label="会话删除" type="checkbox" checked={snapshot?.sessionDeleteEnabled !== false} onChange={(event) => { update({ sessionDeleteEnabled: event.target.checked }) }} disabled={input.setEnabled === undefined && input.setLocalCapability === undefined} /></label>
    </div>
  </section>
}

/** Keeps media classification separate from provider credentials and routing. */
function ModelCategorySettingsPage(input: {
  readonly models: readonly NativeCatalogModel[]
  readonly categories: Readonly<Record<string, ModelCategory>>
  readonly setCategory: Injected['modelCategorySet']
  readonly language: 'zh' | 'en'
  readonly onSnapshot: (value: CapabilitySnapshot) => void
  readonly onError: (message: string) => void
}): ReactNode {
  const [busyKey, setBusyKey] = useState<string | undefined>(undefined)
  const text = input.language === 'zh'
    ? { title: '模型分类', badge: '多提供商媒体路由', description: '模型、API 地址和 Key 仍在 Harness 的「模型」页面配置。这里识别或手动标记文本、生图、视频与语音能力；媒体分类会进入对应默认模型下拉框，并由插件工具按原提供商地址调用。', empty: '尚未发现模型。请先到 Harness 设置的「模型」页面添加第三方 API 或模型。', auto: '自动识别为', manual: '已手动分类为', aria: (name: string) => `${name} 模型分类`, autoOption: (label: string) => `自动识别（${label}）` }
    : { title: 'Model categories', badge: 'Multi-provider media routing', description: 'Models, endpoints, and API keys remain configured on the Harness Models page. Classifications feed the media defaults and route plugin media tools through the model\'s original provider endpoint.', empty: 'No models were found. Add a third-party API or model in the Harness Models page first.', auto: 'Automatically classified as', manual: 'Manually classified as', aria: (name: string) => `${name} model category`, autoOption: (label: string) => `Automatic (${label})` }
  const update = (model: NativeCatalogModel, category: string): void => {
    if (input.setCategory === undefined || busyKey !== undefined) return
    setBusyKey(model.key)
    const override = category === '' ? undefined : category as ModelCategory
    void input.setCategory({ key: model.key, ...(override === undefined ? {} : { category: override }) }).then((result) => {
      if (result.ok) input.onSnapshot(result.value)
      else input.onError(result.error.message)
    }, (error: unknown) => { input.onError(error instanceof Error ? error.message : String(error)) }).finally(() => { setBusyKey(undefined) })
  }
  return <section className={css.section}>
    <div className={css.sectionHeader}><div><div className={css.kicker}>MODEL CAPABILITIES</div><strong className={css.sectionName}>{text.title}</strong></div><span className={css.badge}>{text.badge}</span></div>
    <small className={css.sectionMeta}>{text.description}</small>
    {input.models.length === 0 ? <small className={css.sectionMeta}>{text.empty}</small> : <div className={css.accountList}>
      {input.models.map((model) => {
        const configured = input.categories[model.key]
        const effective = configured ?? inferredModelCategory(model.provider, model.id, model.displayName)
        return <div className={css.accountRow} key={model.key}>
          <div className={css.accountIdentity}><strong className={css.accountName}>{model.displayName}</strong><small className={css.accountEmail}>{model.providerName} · {visibleModelId(model.provider, model.id)} · {configured === undefined ? `${text.auto} ${categoryLabel(effective, input.language)}` : `${text.manual} ${categoryLabel(effective, input.language)}`}</small></div>
          <div className={css.accountActions}><select className={css.select} aria-label={text.aria(model.displayName)} value={configured ?? ''} disabled={input.setCategory === undefined || busyKey === model.key} onChange={(event) => { update(model, event.target.value) }}><option value="">{text.autoOption(categoryLabel(inferredModelCategory(model.provider, model.id, model.displayName), input.language))}</option><option value="text">{categoryLabel('text', input.language)}</option><option value="image">{categoryLabel('image', input.language)}</option><option value="video">{categoryLabel('video', input.language)}</option><option value="audio">{categoryLabel('audio', input.language)}</option></select></div>
        </div>
      })}
    </div>}
  </section>
}

/**
 * Desktop sessions of the signed-in account.
 *
 * Loaded on demand instead of on mount: the list is only interesting when a
 * user suspects another machine, and a mount effect would re-query the backend
 * on every settings re-render. Revoking this device's own session signs the
 * account out, so "revoke all" needs an explicit second click.
 */
export function DeviceSessionManager(input: {
  readonly load?: () => Promise<RemoteResult<FreeCodeGoDeviceSessions>>
  readonly revoke?: (deviceId: string) => Promise<RemoteResult<FreeCodeGoDeviceSessions>>
  readonly revokeAll?: () => Promise<RemoteResult<number>>
  /**
   * Buttons that belong on the same row as the device-session disclosure. The
   * raw-account read used to sit under a disclosure of its own, which cost a row
   * of chrome for a button that only ever needed to be beside this one.
   */
  readonly extraActions?: ReactNode
  readonly language: 'zh' | 'en'
}): ReactNode {
  const zh = input.language === 'zh'
  const [open, setOpen] = useState(false)
  const [sessions, setSessions] = useState<FreeCodeGoDeviceSessions | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [confirmAll, setConfirmAll] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const run = (key: string, call: () => Promise<RemoteResult<FreeCodeGoDeviceSessions>>): void => {
    setBusy(key)
    setError(undefined)
    void call().then((result) => {
      if (result.ok) setSessions(result.value)
      else setError(result.error.message)
    }, (failure: unknown) => { setError(failure instanceof Error ? failure.message : String(failure)) }).finally(() => { setBusy(undefined) })
  }

  const refresh = (): void => {
    if (input.load === undefined) return
    run('load', input.load)
  }

  const revokeOne = (deviceId: string): void => {
    if (input.revoke === undefined) return
    setNotice(undefined)
    run(`revoke:${deviceId}`, () => input.revoke!(deviceId))
  }

  const revokeEverything = (): void => {
    if (input.revokeAll === undefined) return
    if (!confirmAll) { setConfirmAll(true); return }
    setConfirmAll(false)
    setBusy('all')
    setError(undefined)
    setNotice(undefined)
    void input.revokeAll().then((result) => {
      if (!result.ok) { setError(result.error.message); return }
      setSessions({ sessions: [] })
      setNotice(zh ? `已撤销 ${result.value} 个会话，请重新登录。` : `Revoked ${result.value} sessions. Please sign in again.`)
    }, (failure: unknown) => { setError(failure instanceof Error ? failure.message : String(failure)) }).finally(() => { setBusy(undefined) })
  }

  if (input.load === undefined) return null
  // Revoked sessions are history, not devices: the backend keeps the rows for
  // audit, but a card titled "sign out other machines" has nothing to say about
  // machines that are already signed out, so they are filtered out here and the
  // empty state speaks for a fully-revoked list.
  const rows = (sessions?.sessions ?? []).filter(session => !session.revoked)
  return <div className={css.accountManager}>
    <div className={css.accountActions}>
      {input.extraActions}
      {/* The list is a disclosure: the same button opens it and folds it away,
          instead of offering an open action with no visible close. */}
      <button className={css.button} type="button" aria-expanded={open} onClick={() => { setOpen(previous => !previous); if (!open) refresh() }} disabled={busy !== undefined}>{open ? (zh ? '收起设备列表' : 'Hide device list') : (zh ? '管理设备会话' : 'Manage device sessions')}</button>
      {open ? <button className={css.button} type="button" onClick={refresh} disabled={busy !== undefined}>{zh ? '刷新' : 'Refresh'}</button> : null}
      {open && input.revokeAll !== undefined ? <button className={`${css.button} ${css.buttonDanger}`} type="button" onClick={revokeEverything} disabled={busy !== undefined}>{confirmAll ? (zh ? '确认撤销全部？' : 'Confirm revoke all?') : (zh ? '撤销全部会话' : 'Revoke all sessions')}</button> : null}
    </div>
    {open ? <small className={css.sectionMeta}>{zh ? '在其它设备上注销登录。被撤销的设备需要重新输入密码。' : 'Sign out other machines. A revoked device must sign in again.'}</small> : null}
    {error === undefined ? null : <small className={css.sectionMeta}>{error}</small>}
    {notice === undefined ? null : <small className={css.sectionMeta}>{notice}</small>}
    {open && busy === 'load' ? <small className={css.sectionMeta}>{zh ? '正在读取设备…' : 'Loading devices…'}</small> : null}
    {open && sessions !== undefined ? <div className={css.accountList}>
      {rows.length === 0 ? <small className={css.sectionMeta}>{zh ? '没有可撤销的设备会话。' : 'No device sessions to revoke.'}</small> : rows.map(session => <div className={css.accountRow} key={session.deviceId}>
        <div className={css.accountIdentity}>
          <strong className={css.accountName}>{session.deviceName ?? session.deviceId}{session.current ? (zh ? '（本机）' : ' (this device)') : ''}</strong>
          <small className={css.accountEmail}>{[session.os, session.arch, session.clientVersion, session.lastSeenAt].filter(part => typeof part === 'string' && part !== '').join(' · ')}</small>
        </div>
        <div className={css.accountActions}>
          <button className={`${css.button} ${css.buttonDanger}`} type="button" onClick={() => { revokeOne(session.deviceId) }} disabled={busy !== undefined || input.revoke === undefined}>{busy === `revoke:${session.deviceId}` ? (zh ? '撤销中…' : 'Revoking…') : (zh ? '撤销' : 'Revoke')}</button>
        </div>
      </div>)}
    </div> : null}
  </div>
}

export function categoryLabel(category: ModelCategory, language: 'zh' | 'en' = 'zh'): string {
  if (language === 'en') return category === 'text' ? 'Text model' : category === 'image' ? 'Image generation model' : category === 'video' ? 'Video generation model' : 'Audio model'
  return category === 'text' ? '文本模型' : category === 'image' ? '生图模型' : category === 'video' ? '视频模型' : '语音模型'
}

function AdvisorSettingsPage(input: {
  readonly snapshot: AdvisorSnapshot | undefined
  readonly update: Injected['advisorUpdate']
  readonly models: Injected['advisorModels']
  readonly onSnapshot: (value: AdvisorSnapshot) => void
  readonly onError: (message: string | undefined) => void
  /** Manual review action; absent leaves the button out entirely. */
  readonly onReview?: (() => void) | undefined
  readonly reviewBusy?: boolean
  readonly reviewNote?: string | undefined
  readonly standalone?: boolean
}): ReactNode {
  const snapshot = input.snapshot
  const [provider, setProvider] = useState(snapshot?.provider ?? '')
  const [model, setModel] = useState(snapshot?.model ?? '')
  const [allowControl, setAllowControl] = useState(false)
  const [cooldown, setCooldown] = useState('3')
  const [busy, setBusy] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [models, setModels] = useState<readonly AdvisorModelChoice[]>([])
  const [modelQuery, setModelQuery] = useState('')
  const [modelError, setModelError] = useState<string | undefined>(undefined)
  const [modelLoading, setModelLoading] = useState(false)
  useEffect(() => {
    setProvider(snapshot?.provider ?? '')
    setModel(snapshot?.model ?? '')
    setAllowControl(snapshot?.allowAgentControl ?? false)
    setCooldown(String(snapshot?.interruptCooldownTurns ?? 3))
  }, [snapshot?.provider, snapshot?.model, snapshot?.allowAgentControl, snapshot?.interruptCooldownTurns])
  const update = (patch: AdvisorUpdate): void => {
    if (input.update === undefined || busy) return
    setBusy(true)
    void input.update(patch).then((result) => {
      if (result.ok) { input.onError(undefined); input.onSnapshot(result.value) }
      else input.onError(result.error.message)
    }, (error: unknown) => { input.onError(error instanceof Error ? error.message : String(error)) }).finally(() => { setBusy(false) })
  }
  const saveRoute = (): void => { update({
    advisorProvider: provider.trim(),
    advisorModel: model.trim(),
    advisorAllowAgentControl: allowControl,
    advisorInterruptCooldownTurns: Math.max(0, Math.min(20, Number.parseInt(cooldown, 10) || 0)),
  }) }
  const openPicker = (): void => {
    setPickerOpen(true)
    setModelQuery('')
    if (input.models === undefined || modelLoading) return
    setModelLoading(true)
    setModelError(undefined)
    void input.models().then((result) => {
      if (result.ok) setModels(result.value)
      else setModelError(result.error.message)
    }, (error: unknown) => { setModelError(error instanceof Error ? error.message : String(error)) }).finally(() => { setModelLoading(false) })
  }
  const chooseManagedModel = (choice: AdvisorModelChoice): void => {
    setProvider(choice.provider)
    setModel(choice.id)
    setPickerOpen(false)
    update({ advisorProvider: choice.provider, advisorModel: choice.id })
  }
  const filteredModels = models.filter(choice => `${choice.displayName} ${choice.id} ${choice.description}`.toLocaleLowerCase().includes(modelQuery.trim().toLocaleLowerCase()))
  const status = snapshot === undefined ? '正在读取…' : !snapshot.enabled ? '未启用' : snapshot.routeReady ? '可运行' : '待配置'
  const statusDescription = snapshot === undefined ? '正在读取独立审查路由' : !snapshot.enabled ? '打开开关后才会开始审查' : snapshot.routeReady ? '独立 LLM 路由已就绪' : '请选择审查模型后才会开始工作'
  return <section className={`${css.section} ${input.standalone ? css.advisorStandalone : ''}`}>
    <div className={css.sectionHeader}><div><div className={css.kicker}>ADVISOR SUPERVISION</div><strong className={css.sectionName}>Advisor 监督</strong></div><div className={css.accountActions}><span className={`${css.badge} ${snapshot?.enabled && snapshot.routeReady ? css.badgeLive : ''}`}>{snapshot?.enabled && snapshot.routeReady ? '可运行' : snapshot?.enabled ? '待配置' : '未启用'}</span>{input.onReview === undefined ? null : <button className={css.button} type="button" onClick={input.onReview} disabled={input.reviewBusy === true}>{input.reviewBusy === true ? '触发中…' : '立即复核当前会话'}</button>}</div></div>
    {input.reviewNote === undefined ? null : <small className={css.sectionMeta} role="status">{input.reviewNote}</small>}
    <small className={css.sectionMeta}>Host 在每轮结束后以独立模型复核 DeepSeek、Claude 与 Codex 会话。它只能读取当前工作目录，不会共享主 Agent 的写入、终端或网络工具。</small>
    {input.standalone ? null : <div className={css.extensionList}>
      <label className={css.extensionRow}><span><strong>启用 Advisor</strong><small>开启后显示左侧入口，并按所选模式开始异步复核已完成的主 Agent 回合。</small></span><input className={css.switch} aria-label="启用 Advisor" type="checkbox" checked={snapshot?.enabled === true} onChange={(event) => { update({ advisorEnabled: event.target.checked }) }} disabled={input.update === undefined || busy} /></label>
    </div>}
    <div className={css.advisorStats}>
      <div><strong>{status}</strong><small>{statusDescription}</small></div><div><strong>{snapshot?.activeSessions ?? 0}</strong><small title="Advisor 已经处理过回合的会话数。刚启动的 Host 在第一个回合结束前必然是 0。">本次已审查会话</small></div><div><strong>{snapshot?.queuedReviews ?? 0}</strong><small title="正在后台复核的回合数，不是积压队列。">进行中审查</small></div><div><strong>{snapshot?.noteCount ?? 0}</strong><small title="已完成并写入会话记录的审查建议数。">已产出建议</small></div><div><strong>{snapshot === undefined ? 0 : snapshot.inputTokens + snapshot.outputTokens}</strong><small>累计 tokens</small></div>
    </div>
    {snapshot === undefined || snapshot.activeSessions > 0 ? null : <small className={css.sectionMeta}>
      {snapshot.enabled && snapshot.routeReady
        ? '尚未审查任何回合。Advisor 在每次主 Agent 回合结束时自动触发；完成一个回合后这里会开始计数。'
        : 'Advisor 尚未开始工作。启用并选好审查模型后，Host 会在每个回合结束时自动复核。'}
    </small>}
    {snapshot?.lastError === undefined ? null : <div className={css.advisorWarning} role="status">最近错误：{snapshot.lastError}{snapshot.backoffRemainingTurns === undefined ? '' : `（连续失败退避中，还有约 ${snapshot.backoffRemainingTurns} 个回合后重试；手动审查不受影响）`}</div>}
    {/* Review behaviour: mode and model are one logical pair (how hard it
        reviews and with what), so they share a two-column row instead of each
        owning a full-width form row. */}
    <div className={css.advisorFormGrid}>
      <label className={css.advisorField}><span>审查模式</span><select className={css.select} value={snapshot?.mode ?? 'async'} onChange={(event) => { update({ advisorMode: event.target.value as AdvisorSnapshot['mode'] }) }} disabled={input.update === undefined || busy}><option value="async">异步，不阻塞主回合</option><option value="catchup">最多等待 30 秒后继续</option><option value="blocker-only">只记录 blocker</option></select></label>
      <div className={css.advisorField}><span>审查模型</span><button className={css.advisorModelTrigger} type="button" onClick={openPicker} disabled={input.models === undefined || busy}><strong>{model === '' ? '选择一个可用模型' : model}</strong><small>{provider === '' ? '点击从可用模型中选择' : `Provider: ${provider}`}</small></button></div>
      <label className={css.advisorField}><span>介入冷却回合</span><input className={css.input} type="number" min="0" max="20" value={cooldown} onChange={(event) => { setCooldown(event.target.value) }} /></label>
    </div>
    <label className={css.toggleCard}>
      <span className={css.toggleCardText}><strong>允许 Advisor 主动投递建议给 Agent</strong><small>关闭时仍会持久化审查建议，但不会影响主 Agent 后续回合</small></span>
      <input className={css.switch} aria-label="允许 Advisor 主动投递建议给 Agent" type="checkbox" checked={allowControl} onChange={(event) => { setAllowControl(event.target.checked) }} disabled={busy} />
    </label>
    {pickerOpen ? <div className={css.advisorPickerBackdrop} role="presentation" onMouseDown={() => { setPickerOpen(false) }}><section className={css.advisorPicker} role="dialog" aria-modal="true" aria-label="选择 Advisor 审查模型" onMouseDown={(event) => { event.stopPropagation() }}><div className={css.advisorPickerHeader}><div><strong>选择审查模型</strong><small>仅显示当前账户可用的文本模型。选择后会自动配置独立路由。</small></div><button className={css.button} type="button" onClick={() => { setPickerOpen(false) }}>关闭</button></div><input className={css.input} autoFocus value={modelQuery} onChange={(event) => { setModelQuery(event.target.value) }} placeholder="搜索模型名称或 ID" />{modelLoading ? <div className={css.emptyCapability}>正在加载模型目录…</div> : modelError === undefined ? <div className={css.advisorModelList}>{filteredModels.map(choice => <button className={`${css.advisorModelOption} ${choice.id === model && choice.provider === provider ? css.advisorModelSelected : ''}`} type="button" key={`${choice.provider}:${choice.id}`} onClick={() => { chooseManagedModel(choice) }}><span><strong>{choice.displayName}</strong><small>{choice.description}</small></span><code>{visibleModelId(choice.provider, choice.id)}</code></button>)}{filteredModels.length === 0 ? <div className={css.emptyCapability}>没有匹配的可用文本模型。</div> : null}</div> : <div className={css.alert} role="alert">模型目录读取失败：{modelError}</div>}<details className={css.advisorManual}><summary>手动配置第三方路由</summary><small>仅在第三方 provider 未出现在目录时使用。手动输入后点击保存配置。</small><div className={css.capabilityForm}><label><span>Provider</span><input className={css.input} value={provider} onChange={(event) => { setProvider(event.target.value) }} placeholder="provider" /></label><label><span>Model ID</span><input className={css.input} value={model} onChange={(event) => { setModel(event.target.value) }} placeholder="model-id" /></label></div></details></section></div> : null}
    <div className={css.advisorFoot}>
      <div className={css.advisorEvidence}>
        <strong>只读证据工具</strong>
        <span>{snapshot?.reviewTools.join(' · ') ?? 'read · glob · grep'}</span>
        <small>规则文件：{snapshot === undefined || snapshot.watchdogFiles.length === 0 ? '未发现 WATCHDOG.md / WATCHDOG.yml' : snapshot.watchdogFiles.join('；')}</small>
      </div>
      <button className={`${css.button} ${css.buttonPrimary}`} type="button" onClick={saveRoute} disabled={input.update === undefined || busy}>{busy ? '保存中…' : '保存 Advisor 配置'}</button>
    </div>
  </section>
}

/** Surface durable record-mode notes without granting the Advisor control of the main Agent. */
function AdvisorNotesPanel(input: { readonly load: NonNullable<Injected['advisorNotes']> }): ReactNode {
  const [notes, setNotes] = useState<readonly AdvisorNote[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const refresh = (): void => {
    setLoading(true)
    void input.load().then((result) => {
      if (result.ok) { setNotes(result.value); setError(undefined) }
      else setError(result.error.message)
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { setLoading(false) })
  }
  useEffect(() => {
    refresh()
  }, [input.load])
  return <section className={css.section}>
    <div className={css.sectionHeader}><div><div className={css.kicker}>DURABLE REVIEW NOTES</div><strong className={css.sectionName}>最近建议</strong></div><button className={css.button} type="button" onClick={refresh} disabled={loading}>{loading ? '读取中…' : '刷新'}</button></div>
    <small className={css.sectionMeta}>即使未允许 Advisor 介入主 Agent，审查建议也会保存在会话中并在此显示。当前仅列出仍在运行的会话。</small>
    {error === undefined ? null : <div className={css.alert} role="alert">建议读取失败：{error}</div>}
    {loading ? <div className={css.emptyCapability}>正在读取当前会话的审查建议…</div> : notes.length === 0 ? <div className={css.emptyCapability}>尚未产生 Advisor 建议。完成一个 Agent 回合后会自动审查。</div> : <div className={css.advisorNotes}>{notes.map(note => <article className={css.advisorNote} key={note.id}><div className={css.advisorNoteHeader}><span className={`${css.advisorSeverity} ${note.severity === 'blocker' ? css.advisorSeverityBlocker : note.severity === 'concern' ? css.advisorSeverityConcern : css.advisorSeverityNit}`}>{note.severity}</span><small>{note.delivery === 'record' ? '仅记录' : note.delivery === 'inject' ? '已注入下一步' : '已请求纠偏'}</small></div><p>{note.note}</p><footer>会话 {note.sessionId} · 回合 {note.turn} · {new Date(note.time).toLocaleString()}</footer></article>)}</div>}
  </section>
}

function MarketplaceMcpIcon({ item }: { readonly item: MarketplaceMcpItem }): ReactNode {
  const [failed, setFailed] = useState(false)
  if (item.iconUrl !== undefined && !failed) return <img className={css.mcpMarketplaceIcon} src={item.iconUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => { setFailed(true) }} />
  return <span className={css.mcpPresetIcon}><McpIcon size={18} /></span>
}

function ConfiguredMcpIcon({ server, recommended }: { readonly server: CapabilityMcpServer; readonly recommended: MarketplaceMcpPage | undefined }): ReactNode {
  const name = server.serverName.trim().toLocaleLowerCase()
  const item = recommended?.items.find(candidate => candidate.title.toLocaleLowerCase().includes(name))
  return item === undefined ? <div className={css.mcpServerIcon}><McpIcon size={18} /></div> : <MarketplaceMcpIcon item={item} />
}

function McpCapabilityPage(input: {
  readonly snapshot: CapabilitySnapshot | undefined
  readonly save: Injected['mcpSave']
  readonly remove: Injected['mcpRemove']
  readonly marketplace: NonNullable<Injected['capabilityMarketplace']>
  readonly installMarketplace: NonNullable<Injected['mcpPresetInstall']>
  readonly onSnapshot: (value: CapabilitySnapshot) => void
  readonly onError: (message: string) => void
  readonly language: 'zh' | 'en'
}): ReactNode {
  const [transport, setTransport] = useState<'stdio' | 'streamable-http'>('streamable-http')
  const [serverName, setServerName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('[]')
  const [cwd, setCwd] = useState('')
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState('{}')
  const [env, setEnv] = useState('{}')
  const [editingId, setEditingId] = useState<string | undefined>(undefined)
  const [formOpen, setFormOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [jsonDraft, setJsonDraft] = useState('')
  const [jsonOpen, setJsonOpen] = useState(false)
  const [selectedRecommended, setSelectedRecommended] = useState<MarketplaceMcpItem | undefined>(undefined)
  const [recommended, setRecommended] = useState<MarketplaceMcpPage | undefined>(undefined)
  const [recommendedLoading, setRecommendedLoading] = useState(true)
  const [recommendedError, setRecommendedError] = useState<string | undefined>(undefined)
  const toolsFor = (server: CapabilityMcpServer): number => input.snapshot?.mcpTools.filter(tool => tool.name.startsWith(`mcp__${server.serverName}__`)).length ?? 0
  const mountErrorFor = (server: CapabilityMcpServer): string | undefined =>
    input.snapshot?.mountErrors?.find(entry => entry.id === server.id)?.message
  useEffect(() => {
    let active = true
    setRecommendedLoading(true)
    void input.marketplace({ kind: 'mcp', category: 'freecodego-featured', limit: 12 }).then((result) => {
      if (!active) return
      if (result.ok && result.value.kind === 'mcp') {
        setRecommended(result.value as MarketplaceMcpPage)
        setRecommendedError(undefined)
      } else {
        setRecommendedError(result.ok ? '社区目录返回了无效的 MCP 数据。' : result.error.message)
      }
    }, (error: unknown) => { if (active) setRecommendedError(error instanceof Error ? error.message : String(error)) }).finally(() => { if (active) setRecommendedLoading(false) })
    return () => { active = false }
  }, [input.marketplace])
  const resetForm = (): void => {
    setEditingId(undefined); setTransport('streamable-http'); setServerName(''); setCommand(''); setArgs('[]'); setCwd(''); setUrl(''); setHeaders('{}'); setEnv('{}')
  }
  const edit = (server: CapabilityMcpServer): void => {
    setEditingId(server.id); setTransport(server.transport); setServerName(server.serverName); setCommand(server.command); setArgs(JSON.stringify(server.args)); setCwd(server.cwd); setUrl(server.url); setHeaders(JSON.stringify(server.headers)); setEnv(JSON.stringify(server.env)); setFormOpen(true)
  }
  const applyTemplate = (template: 'filesystem' | 'http'): void => {
    if (template === 'filesystem') {
      setTransport('stdio'); setServerName('filesystem'); setCommand('npx'); setArgs('["-y", "@modelcontextprotocol/server-filesystem", "."]'); setCwd(''); setEnv('{}')
    } else {
      setTransport('streamable-http'); setServerName(''); setUrl(''); setHeaders('{"Authorization":"Bearer ..."}')
    }
    setEditingId(undefined); setFormOpen(true)
  }
  const installRecommended = (item: MarketplaceMcpItem): void => {
    if (busy || item.installed || !item.installable) return
    setBusy(true)
    void input.installMarketplace(item.id).then((result) => {
      if (!result.ok) { input.onError(result.error.message); return }
      input.onSnapshot(result.value)
      publishCapabilitySnapshot(result.value)
      setRecommended(previous => previous === undefined ? previous : { ...previous, items: previous.items.map(current => current.id === item.id ? { ...current, installed: true } : current) })
    }, (error: unknown) => { input.onError(error instanceof Error ? error.message : String(error)) }).finally(() => { setBusy(false) })
  }
  const importJson = (): void => {
    if (input.save === undefined || busy) return
    const sourceText = jsonDraft.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/u, '')
    let parsed: unknown
    try { parsed = JSON.parse(sourceText) } catch (error) { input.onError(`MCP JSON 格式无效：${error instanceof Error ? error.message : String(error)}`); return }
    const root = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
    const source = root?.mcpServers ?? root?.mcp_servers ?? (root !== undefined && (typeof root.command === 'string' || typeof root.url === 'string') ? { [typeof root.name === 'string' && root.name.trim() !== '' ? root.name : 'mcp-server']: root } : parsed)
    if (source === null || typeof source !== 'object' || Array.isArray(source)) { input.onError('MCP JSON 必须是对象，或包含 mcpServers 对象。'); return }
    const definitions: Array<Omit<CapabilityMcpServer, 'id'> & { id?: string }> = []
    for (const [name, raw] of Object.entries(source as Record<string, unknown>)) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { input.onError(`MCP 服务器 ${name} 配置必须是对象。`); return }
      const value = raw as Record<string, unknown>
      const commandValue = typeof value.command === 'string' ? value.command.trim() : ''
      const urlValue = typeof value.url === 'string' ? value.url.trim() : ''
      const transportValue = value.transport === 'stdio' || value.transport === 'streamable-http' ? value.transport : commandValue !== '' ? 'stdio' : 'streamable-http'
      const argsValue = value.args === undefined ? [] : value.args
      const envValue = value.env === undefined ? {} : value.env
      const headersValue = value.headers === undefined ? {} : value.headers
      if (!Array.isArray(argsValue) || argsValue.some(item => typeof item !== 'string')) { input.onError(`MCP 服务器 ${name} 的 args 必须是字符串数组。`); return }
      const asStringRecord = (candidate: unknown, label: string): Record<string, string> | undefined => {
        if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate) || Object.values(candidate as Record<string, unknown>).some(item => typeof item !== 'string')) { input.onError(`MCP 服务器 ${name} 的 ${label} 必须是字符串键值对象。`); return undefined }
        return candidate as Record<string, string>
      }
      const envRecord = asStringRecord(envValue, 'env')
      const headersRecord = asStringRecord(headersValue, 'headers')
      if (envRecord === undefined || headersRecord === undefined) return
      const existing = input.snapshot?.mcpServers.find(server => server.serverName === name)
      definitions.push({ ...(existing === undefined ? {} : { id: existing.id }), enabled: value.enabled !== false, transport: transportValue, serverName: name, command: commandValue, args: argsValue as string[], cwd: typeof value.cwd === 'string' ? value.cwd : '', url: urlValue, headers: headersRecord, env: envRecord })
    }
    if (definitions.length === 0) { input.onError('MCP JSON 中没有可导入的服务器。'); return }
    setBusy(true)
    void (async () => {
      for (const definition of definitions) {
        const result = await input.save!(definition)
        if (!result.ok) throw new Error(result.error.message)
        input.onSnapshot(result.value)
      }
      setJsonDraft(''); setJsonOpen(false)
    })().catch((error: unknown) => { input.onError(error instanceof Error ? error.message : String(error)) }).finally(() => { setBusy(false) })
  }
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (input.save === undefined || busy) return
    let parsedArgs: string[]
    let parsedHeaders: Record<string, string>
    let parsedEnv: Record<string, string>
    try {
      parsedArgs = readStringArray(args, '参数')
      parsedHeaders = readStringRecord(headers, 'HTTP Headers')
      parsedEnv = readStringRecord(env, '环境变量')
    } catch (error) { input.onError(error instanceof Error ? error.message : String(error)); return }
    setBusy(true)
    const previous = editingId === undefined ? undefined : input.snapshot?.mcpServers.find(server => server.id === editingId)
    void input.save({ ...(editingId === undefined ? {} : { id: editingId }), enabled: previous?.enabled ?? true, transport, serverName, command, args: parsedArgs, cwd, url, headers: parsedHeaders, env: parsedEnv }).then((result) => {
      if (result.ok) { input.onSnapshot(result.value); resetForm(); setFormOpen(false) }
      else input.onError(result.error.message)
    }, (error: unknown) => { input.onError(error instanceof Error ? error.message : String(error)) }).finally(() => { setBusy(false) })
  }
  const remove = (id: string): void => {
    if (input.remove === undefined) return
    void input.remove(id).then((result) => { if (result.ok) input.onSnapshot(result.value); else input.onError(result.error.message) }, (error: unknown) => { input.onError(error instanceof Error ? error.message : String(error)) })
  }
  const toggle = (server: CapabilityMcpServer): void => {
    if (input.save === undefined) return
    void input.save({ ...server, enabled: !server.enabled }).then((result) => { if (result.ok) input.onSnapshot(result.value); else input.onError(result.error.message) }, (error: unknown) => { input.onError(error instanceof Error ? error.message : String(error)) })
  }
  return <section className={css.section}>
    <div className={css.sectionHeader}><div><div className={css.kicker}>MCP</div><strong className={css.sectionName}>MCP Servers</strong></div><div className={css.accountActions}><span className={`${css.badge} ${input.snapshot?.mcpEnabled ? css.badgeLive : ''}`}>{input.snapshot?.mcpEnabled ? '运行中' : '已关闭'}</span><button className={`${css.button} ${css.buttonPrimary}`} type="button" onClick={() => { resetForm(); setFormOpen(open => !open) }}>添加服务器</button></div></div>
    <small className={css.sectionMeta}>由 Harness Host 统一管理连接和工具。DeepSeek、Claude 与 Codex 使用同一份已启用服务配置。</small>
    <div className={css.capabilityStats}><div><strong>{input.snapshot?.mcpServers.length ?? 0}</strong><small>已配置服务</small></div><div><strong>{input.snapshot?.mcpServers.filter(server => server.enabled).length ?? 0}</strong><small>已启用</small></div><div><strong>{input.snapshot?.mcpTools.length ?? 0}</strong><small>已发现工具</small></div></div>
    <div className={css.mcpTemplateBar}><span>快速配置</span><button className={css.templateButton} type="button" onClick={() => { applyTemplate('filesystem') }}><McpIcon size={13} />本地文件</button><button className={css.templateButton} type="button" onClick={() => { applyTemplate('http') }}><McpIcon size={13} />Streamable HTTP</button><button className={css.templateButton} type="button" onClick={() => { setJsonOpen(open => !open) }}><McpIcon size={13} />粘贴 JSON</button></div>
    {jsonOpen ? <div className={css.mcpJsonPanel}><div className={css.capabilityFormHead}><strong>从 JSON 导入 MCP</strong><small>支持 Claude/Codex 常见的 `mcpServers` 配置格式，可一次导入多个服务。</small></div><textarea className={css.mcpJsonInput} value={jsonDraft} onChange={(event) => { setJsonDraft(event.target.value) }} placeholder={'{\n  "mcpServers": {\n    "context7": {\n      "url": "https://mcp.context7.com/mcp"\n    }\n  }\n}'} spellCheck={false} /><div className={css.accountActions}><button className={`${css.button} ${css.buttonPrimary}`} type="button" disabled={busy || input.save === undefined || jsonDraft.trim() === ''} onClick={importJson}>{busy ? '导入中…' : '导入并连接'}</button><button className={css.button} type="button" onClick={() => { setJsonDraft(''); setJsonOpen(false) }}>取消</button></div></div> : null}
    <div className={css.mcpServerList}>{input.snapshot?.mcpServers.length ? input.snapshot.mcpServers.map(server => <article className={css.mcpServerCard} key={server.id}><ConfiguredMcpIcon server={server} recommended={recommended} /><div className={css.mcpServerMain}><div className={css.mcpServerTitle}><strong>{server.serverName}</strong><span className={`${css.badge} ${server.enabled && toolsFor(server) > 0 ? css.badgeLive : ''}`}>{!server.enabled ? '已暂停' : mountErrorFor(server) !== undefined ? '挂载失败' : toolsFor(server) > 0 ? `已连接 · ${toolsFor(server)} tools` : '正在连接'}</span></div><small>{server.transport === 'stdio' ? `${server.command} ${server.args.join(' ')}` : server.url}{mountErrorFor(server) === undefined ? '' : ` · 挂载失败：${mountErrorFor(server)}`}</small></div><div className={css.mcpServerActions}><label className={css.inlineSwitch}><input aria-label={`${server.serverName} enabled`} type="checkbox" checked={server.enabled} onChange={() => { toggle(server) }} /><span>启用</span></label><button className={css.button} type="button" onClick={() => { edit(server) }}>编辑</button><button className={`${css.button} ${css.buttonDanger}`} type="button" onClick={() => { remove(server.id) }}>移除</button></div></article>) : <div className={css.emptyCapability}><strong>还没有 MCP 服务</strong><small>从上方预设、JSON 导入或社区精选开始添加。</small></div>}</div>
    <div className={css.mcpPresetHeading}><strong>社区 MCP 推荐</strong><small>{recommended === undefined ? '正在读取与社区精选同步的 MCP 目录…' : `${recommended.total.toLocaleString()} 个条目，按热度推荐可自动安装项。`}</small></div>
    {recommendedLoading ? <p className={css.loading}>正在读取社区 MCP 推荐…</p> : null}
    {recommendedError === undefined ? null : <div className={css.alert} role="alert">社区 MCP 推荐读取失败：{recommendedError}</div>}
    {recommended === undefined || recommendedLoading ? null : <div className={css.mcpMarketplaceGrid}>{recommended.items.map((item, index) => <article className={css.mcpMarketplaceCard} key={item.id}><MarketplaceMcpIcon item={item} /><div className={css.mcpMarketplaceCopy}><div><strong>{item.title}</strong><span>{item.installed ? '已添加' : `#${(recommended.offset + index + 1).toLocaleString()}`}</span></div><small>{item.description}</small><em>{item.author ?? item.category} · ★ {item.popularity.toLocaleString()}</em></div><div className={css.mcpMarketplaceActions}><button className={css.marketplaceLink} type="button" onClick={() => { setSelectedRecommended(item) }}>{capabilityText(input.language).details}</button><button className={`${css.button} ${css.buttonPrimary}`} type="button" disabled={busy || item.installed || !item.installable} onClick={() => { installRecommended(item) }}>{busy ? '添加中…' : item.installed ? '已添加' : item.installable ? '一键添加' : '需手动配置'}</button></div></article>)}</div>}
    {selectedRecommended === undefined ? null : <CapabilityDetailModal item={selectedRecommended} language={input.language} busy={busy} onClose={() => { setSelectedRecommended(undefined) }} onInstall={selectedRecommended.installable && !selectedRecommended.installed ? () => { installRecommended(selectedRecommended) } : undefined} />}
    {formOpen ? <form className={css.capabilityForm} onSubmit={submit}>
      <div className={css.capabilityFormHead}><strong>{editingId === undefined ? '添加 MCP 服务器' : '编辑 MCP 服务器'}</strong><button className={css.button} type="button" onClick={() => { resetForm(); setFormOpen(false) }}>取消</button></div>
      <label><span>传输</span><select className={css.select} value={transport} onChange={(event) => { setTransport(event.target.value as 'stdio' | 'streamable-http') }}><option value="streamable-http">Streamable HTTP</option><option value="stdio">stdio</option></select></label>
      <label><span>服务名称</span><input className={css.input} required value={serverName} onChange={(event) => { setServerName(event.target.value) }} placeholder="github" /></label>
      {transport === 'stdio' ? <><label><span>命令</span><input className={css.input} required value={command} onChange={(event) => { setCommand(event.target.value) }} placeholder="npx" /></label><label><span>参数 JSON</span><input className={css.input} value={args} onChange={(event) => { setArgs(event.target.value) }} placeholder='["-y", "@modelcontextprotocol/server-github"]' /></label><label><span>工作目录</span><input className={css.input} value={cwd} onChange={(event) => { setCwd(event.target.value) }} placeholder="可选" /></label><label><span>环境变量 JSON</span><input className={css.input} value={env} onChange={(event) => { setEnv(event.target.value) }} placeholder='{"GITHUB_TOKEN":"..."}' /></label></> : <label className={css.capabilityFull}><span>MCP URL</span><input className={css.input} required type="url" value={url} onChange={(event) => { setUrl(event.target.value) }} placeholder="https://example.com/mcp" /></label>}
      {transport === 'streamable-http' ? <label className={css.capabilityFull}><span>HTTP Headers JSON</span><input className={css.input} value={headers} onChange={(event) => { setHeaders(event.target.value) }} placeholder='{"Authorization":"Bearer ..."}' /></label> : null}
      <div className={`${css.accountActions} ${css.capabilityFull}`}><button className={`${css.button} ${css.buttonPrimary}`} type="submit" disabled={busy || input.save === undefined}>{busy ? '保存中…' : editingId === undefined ? '添加并连接' : '保存变更'}</button></div>
    </form> : null}
  </section>
}

/** Which invocation policy one library row carries, in the active language. */
function skillInvocationLabel(skill: CapabilitySkillEntry, text: SkillPageText): string {
  if (skill.modelInvocable) return text.invocationAuto
  return skill.userInvocable ? text.invocationManual : text.invocationNone
}

function SkillCapabilityPage(input: {
  readonly snapshot: CapabilitySnapshot | undefined
  readonly save: Injected['skillRootSave']
  readonly remove: Injected['skillRootRemove']
  readonly detail: Injected['skillDetail']
  /** Per-Skill model-invocation override writer; absent on older descriptors. */
  readonly skillInvocationSet?: Injected['skillInvocationSet']
  readonly packs: readonly FreeCodeGoSkillPackStatus[] | undefined
  readonly onEnablePacks: (ids: readonly FreeCodeGoSkillPackStatus['id'][]) => void
  readonly packBusy: boolean
  readonly onSnapshot: (value: CapabilitySnapshot) => void
  readonly onError: (message: string) => void
  readonly language: 'zh' | 'en'
}): ReactNode {
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [selected, setSelected] = useState<CapabilitySkillEntry | undefined>(undefined)
  /** The Skill whose invocation switch is mid-write, so only it is disabled. */
  const [invocationBusy, setInvocationBusy] = useState<string | undefined>(undefined)
  const writeInvocation = (skill: CapabilitySkillEntry, modelInvocable: boolean | undefined): void => {
    if (input.skillInvocationSet === undefined || invocationBusy !== undefined) return
    setInvocationBusy(skill.name)
    void input.skillInvocationSet(modelInvocable === undefined ? { name: skill.name } : { name: skill.name, modelInvocable }).then((result) => {
      if (result.ok) input.onSnapshot(result.value)
      else input.onError(result.error.message)
    }, (error: unknown) => { input.onError(error instanceof Error ? error.message : String(error)) }).finally(() => { setInvocationBusy(undefined) })
  }
  const toggleInvocation = (skill: CapabilitySkillEntry, modelInvocable: boolean): void => { writeInvocation(skill, modelInvocable) }
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (input.save === undefined || busy) return
    setBusy(true)
    void input.save({ enabled: true, path }).then((result) => {
      if (result.ok) { input.onSnapshot(result.value); setPath('') }
      else input.onError(result.error.message)
    }, (error: unknown) => { input.onError(error instanceof Error ? error.message : String(error)) }).finally(() => { setBusy(false) })
  }
  const remove = (id: string): void => {
    if (input.remove === undefined) return
    void input.remove(id).then((result) => { if (result.ok) input.onSnapshot(result.value); else input.onError(result.error.message) }, (error: unknown) => { input.onError(error instanceof Error ? error.message : String(error)) })
  }
  const t = skillPageText(input.language)
  // The dialog is re-read from the latest snapshot by name: writing an override
  // returns a fresh snapshot, and a dialog pinned to the row it opened with
  // would keep showing the chip and switch the user just changed. The clicked
  // row is the fallback for the moment a Skill drops out of the snapshot.
  const openSkill = selected === undefined ? undefined : input.snapshot?.skills.find(entry => entry.name === selected.name) ?? selected
  // A pack that is off is worth naming: the library lists only what is mounted,
  // so without this line the bundled Skills that are switched off look like
  // Skills the plugin does not have.
  const offPacks = (input.packs ?? []).filter(pack => !pack.enabled && pack.count > 0)
  return <section className={css.section}>
    <div className={css.sectionHeader}><div><div className={css.kicker}>Skills</div><strong className={css.sectionName}>{t.sectionName}</strong></div><div className={css.accountActions}><span className={`${css.badge} ${input.snapshot?.skillEnabled ? css.badgeLive : ''}`}>{input.snapshot?.skillEnabled ? t.running : t.off}</span><button className={`${css.button} ${css.buttonPrimary}`} type="button" onClick={() => { setFormOpen(open => !open) }}>{t.addDirectory}</button></div></div>
    <small className={css.sectionMeta}>{t.meta}</small>
    <div className={css.capabilityStats}><div><strong>{input.snapshot?.skillRoots.length ?? 0}</strong><small>{t.extraRoots}</small></div><div><strong>{input.snapshot?.skills.length ?? 0}</strong><small>{t.discovered}</small></div><div><strong>3</strong><small>{t.engines}</small></div></div>
    <section className={css.skillPanel}><div className={css.skillPanelHeader}><strong>{t.rootsTitle}</strong><small>{t.rootsHint}</small></div>{input.snapshot?.skillRoots.length ? <div className={css.mcpServerList}>{input.snapshot.skillRoots.map(root => <article className={css.mcpServerCard} key={root.id}><div className={css.mcpServerMain}><div className={css.mcpServerTitle}><strong>{root.path}</strong><span className={`${css.badge} ${root.enabled ? css.badgeLive : ''}`}>{root.enabled ? t.rootEnabled : t.rootPaused}</span></div><small>{t.rootScan}</small></div><div className={css.mcpServerActions}><button className={`${css.button} ${css.buttonDanger}`} type="button" onClick={() => { remove(root.id) }}>{t.remove}</button></div></article>)}</div> : <div className={css.emptyCapability}><strong>{t.rootsEmptyTitle}</strong><small>{t.rootsEmptyHint}</small></div>}</section>
    {formOpen ? <form className={css.capabilityForm} onSubmit={submit}><div className={css.capabilityFormHead}><strong>{t.formTitle}</strong><button className={css.button} type="button" onClick={() => { setFormOpen(false) }}>{t.cancel}</button></div><label className={css.capabilityFull}><span>{t.formPath}</span><input className={css.input} required value={path} onChange={(event) => { setPath(event.target.value) }} placeholder="E:\\team-skills" /></label><div className={`${css.accountActions} ${css.capabilityFull}`}><button className={`${css.button} ${css.buttonPrimary}`} type="submit" disabled={busy || input.save === undefined}>{busy ? t.saving : t.addAndScan}</button></div></form> : null}
    {offPacks.length === 0 ? null : <div className={`${css.infoCell} ${css.feedbackRow}`}>
      <div className={css.routingCopy}>
        <small className={css.cellLabel}>{t.packsOffLabel}</small>
        {offPacks.map(pack => <strong className={css.cellValue} key={pack.id}>{t.packsOffTitle(pack.count, pack.label)}</strong>)}
        <small className={css.cellHint}>{t.packsOffHint}</small>
      </div>
      <button className={`${css.button} ${css.buttonPrimary}`} type="button" onClick={() => { input.onEnablePacks(offPacks.map(pack => pack.id)) }} disabled={input.packBusy}>{input.packBusy ? t.packEnabling : t.packEnable}</button>
    </div>}
    <section className={css.skillPanel}><div className={css.skillPanelHeader}><strong>{t.skillsTitle}</strong><small>{t.skillsHint}</small></div><small className={css.sectionMeta}>{t.invocationHint}</small>{input.snapshot?.skills.length ? <div className={css.skillList}>{input.snapshot.skills.map(skill => <div className={css.skillCard} key={skill.name}><button className={css.skillCardBody} type="button" onClick={() => { setSelected(skill) }} aria-label={`${t.openDetail}: ${skill.name}`}><span className={css.skillCardHead}><strong>{skill.name}</strong><span className={`${css.badge} ${skill.modelInvocable ? css.badgeLive : ''}`}>{skillInvocationLabel(skill, t)}</span></span><p>{localizedSkillDescription(skill.name, skill.description, input.language)}</p><small>{skill.source}{input.language === 'zh' && !hasLocalizedSkillDescription(skill.name) ? ` · ${t.englishOnly}` : ''}</small></button>{input.skillInvocationSet === undefined ? null : <div className={css.skillCardControl}><label className={css.skillCardToggle} title={t.autoInvokeHint}><input type="checkbox" aria-label={`${t.autoInvoke}: ${skill.name}`} checked={skill.modelInvocable} disabled={invocationBusy === skill.name} onChange={(event) => { toggleInvocation(skill, event.target.checked) }} />{t.autoInvoke}</label>{input.snapshot?.skillInvocationOverrides?.[skill.name] === undefined ? null : <button className={css.skillCardClear} type="button" onClick={() => { writeInvocation(skill, undefined) }} disabled={invocationBusy === skill.name}>{t.followFile}</button>}</div>}</div>)}</div> : <div className={css.emptyCapability}><strong>{t.skillsEmptyTitle}</strong><small>{t.skillsEmptyHint}</small></div>}</section>
    {openSkill === undefined ? null : <SkillDetailModal
      skill={openSkill}
      language={input.language}
      load={async (file) => {
        if (input.detail === undefined) throw new Error('Skill detail Remote is unavailable')
        const result = await input.detail(file === undefined ? { name: openSkill.name } : { name: openSkill.name, file })
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      }}
      overridden={input.snapshot?.skillInvocationOverrides?.[openSkill.name] !== undefined}
      onInvocation={input.skillInvocationSet === undefined ? undefined : (modelInvocable: boolean | undefined) => { writeInvocation(openSkill, modelInvocable) }}
      invocationBusy={invocationBusy === openSkill.name}
      onClose={() => { setSelected(undefined) }}
    />}
  </section>
}

function readStringArray(value: string, label: string): string[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw new Error(`${label} 必须是字符串数组 JSON`)
  return parsed
}

function readStringRecord(value: string, label: string): Record<string, string> {
  const parsed: unknown = JSON.parse(value)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || Object.values(parsed).some(item => typeof item !== 'string')) throw new Error(`${label} 必须是字符串键值 JSON`)
  return parsed as Record<string, string>
}

/**
 * The currency the pay amount is really charged in.
 *
 * An order's own currency is present only when the payment provider reported
 * one: Alipay and WeChat echo none, so their orders arrive without it. The panel
 * is the only place that knows the missing answer, because it priced the order
 * against the channel table — the order even names the channel it was created
 * for. Falling back to `formatMoney`'s `USD` would keep the layout intact and
 * print a lie, so the channel is asked first and `undefined` stays `undefined`.
 */
export function orderSettlementCurrency(order: Pick<PaymentOrder, 'currency' | 'paymentType'>, channels: readonly PaymentChannel[] = []): string | undefined {
  const declared = order.currency?.trim()
  if (declared !== undefined && declared !== '') return declared
  const type = order.paymentType?.trim().toLowerCase()
  if (type === undefined || type === '') return undefined
  // A provider can be offered under more than one spelling of its type
  // (`wxpay` / `wechat`), so the match is normalized on both sides.
  return channels.find(channel => channel.paymentType.trim().toLowerCase() === type)?.currency
}

function formatGatewayPrice(value: number | undefined, currency: string): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return formatAmountInCurrency(value, currency.trim(), value < 0.01 ? 6 : value < 1 ? 4 : 2)
}

function paymentChannelLabel(paymentType: string, language: 'zh' | 'en'): string {
  const normalized = paymentType.trim().toLowerCase()
  // The card channel is named for what the payer holds, not for the processor
  // behind it: "Stripe" is the acquirer, and a shopper who has never heard of it
  // reads the option as something unfamiliar and skips it. The supported methods
  // are listed right under the picker instead.
  const names: Record<string, readonly [string, string]> = {
    alipay: ['支付宝', 'Alipay'], alipay_direct: ['支付宝', 'Alipay'],
    wxpay: ['微信支付', 'WeChat Pay'], wxpay_direct: ['微信支付', 'WeChat Pay'],
    stripe: ['银行卡 / 信用卡', 'Bank card / credit card'], paypal: ['PayPal', 'PayPal'],
  }
  return names[normalized]?.[language === 'zh' ? 0 : 1] ?? paymentType
}

/**
 * Whether a channel is settled by card, i.e. by the branded methods below.
 *
 * Only the card channel accepts these; naming them for a QR channel would
 * advertise methods that channel cannot take.
 */
export function isCardChannel(paymentType: string | undefined): boolean {
  return paymentType !== undefined && paymentType.trim().toLowerCase() === 'stripe'
}

/**
 * The methods the card channel accepts, named the way a payer knows them.
 *
 * Listed because the picker says "card", and "card" alone does not answer the
 * question people actually have — whether *their* card or wallet works. These are
 * the brands the channel is configured for; the card form itself renders the
 * live logos of whatever it will accept.
 */
export const CARD_CHANNEL_METHODS: readonly string[] = ['Visa', 'Mastercard', 'American Express', 'JCB', 'Apple Pay', 'Google Pay']

function cleanModelDisplayName(displayName: string, id: string): string {
  const suffix = ` (${id})`
  return displayName.endsWith(suffix) ? displayName.slice(0, -suffix.length) : displayName
}

/** Split a group-pinned selection id (`id@group:N`) for display.
 *
 * Gateway rows now carry the pin in their id so one model can appear under
 * every backend group it is offered through. Persistence stores the pinned id
 * verbatim (routing reads it back), but a raw `id@group:4` is noise in a label
 * — the display name already says which group the row bills through. */
export function displayModelSelection(selection: string): string {
  const match = /^(.*?)(?:@group:\d+)$/u.exec(selection)
  return match?.[1] ?? selection
}

/**
 * Placeholder for an unset default.
 *
 * The former first option was an always-present, always-clearable "backend
 * default". It was actively misleading: the Host's `defaultModel` is usually
 * unset, so choosing it cleared a default that did not exist and the selection
 * silently reverted on the next load. The placeholder now states the real
 * consequence and is only rendered while the setting is genuinely empty.
 */
function textModelEmptyLabel(category: ModelCategory, language: 'zh' | 'en'): string {
  if (category !== 'text') return language === 'zh' ? '未设置（自动选择）' : 'Not set (automatic)'
  // "Default route" described a local choice the Host no longer makes: an
  // unpinned selection follows the backend's declared default group, then the
  // backend's own order. The readout above the select names the group itself.
  return language === 'zh' ? '未设置（分组由后端决定）' : 'Not set (the group comes from the backend)'
}

export function selectedChannelDescription(channel: PaymentChannel | undefined, language: 'zh' | 'en', paymentConfig?: PaymentConfigSnapshot): string {
  if (channel === undefined) return ''
  const limits = paymentLimitText(channel, language, paymentConfig)
  const fee = channel.feeRate === undefined || channel.feeRate === 0 ? '' : language === 'zh' ? ` · 手续费 ${channel.feeRate}%` : ` · fee ${channel.feeRate}%`
  const multiplier = channel.balanceRechargeMultiplier !== undefined && Number.isFinite(channel.balanceRechargeMultiplier) && channel.balanceRechargeMultiplier > 0
    ? language === 'zh' ? ` · 1 ${channel.currency ?? '单位'} = $${channel.balanceRechargeMultiplier.toFixed(4)} 额度` : ` · 1 ${channel.currency ?? 'unit'} = $${channel.balanceRechargeMultiplier.toFixed(4)} credit`
    : ''
  const fixed = channel.fixedFee !== undefined && channel.fixedFee > 0 ? language === 'zh' ? ` · 固定手续费 ${formatMoney(channel.fixedFee, channel.currency)}` : ` · fixed ${formatMoney(channel.fixedFee, channel.currency)}` : ''
  // Card payments are the documented path: Stripe mails its own receipt to the
  // account address and the panel can fetch the backend's receipt document, so
  // "I need paperwork" is answered where the method is chosen rather than in a
  // separate form. It says 收据 (receipt), not 发票 (tax invoice): a Stripe
  // PaymentIntent cannot raise an invoice — that parameter exists only on
  // Checkout Sessions and Payment Links — and a promise the channel cannot keep
  // is worse than the honest one.
  const receipt = isCardChannel(channel.paymentType)
    ? language === 'zh' ? ' · 支付后可下载收据，付款凭证会发送至账户邮箱' : ' · downloadable receipt after payment'
    : ''
  return `${limits}${fee}${fixed}${multiplier}${receipt}`.trim()
}

/**
 * The channel's own per-order range, or nothing when it declares no usable one.
 *
 * A range that cannot admit any amount is not a limit, it is an absent one: the
 * backend sends `single_min: 0, single_max: 0` when it publishes no bounds, and
 * printing "单笔 0–0 CNY" beside a working buy button states a contradiction —
 * it reads as "no amount is allowed" while every amount above it is on offer.
 * A half-declared range keeps the half it declared, because one real bound is
 * still information (and `∞` is the honest reading of the missing other half).
 */
export function paymentLimitText(channel: PaymentChannel, language: 'zh' | 'en', fallback?: PaymentConfigSnapshot): string {
  // The channel row is the first source; the desktop config's account-wide range
  // is the second. `checkout-info` publishes `single_min`/`single_max` as `0` on
  // deployments that only configure the account-level limits, which is exactly
  // the case that would otherwise print "no amount is allowed".
  //
  // The `> 0` filter applies to the fallback too, and it is not cosmetic: the
  // backend spells "no upper limit" as `max_amount: 0`, so trusting the number
  // prints `单笔 1–0` — a range that admits nothing — beside working buy buttons.
  const declaredMin = fallback?.minAmount
  const declaredMax = fallback?.maxAmount
  const min = channel.singleMin !== undefined && channel.singleMin > 0 ? channel.singleMin : declaredMin !== undefined && declaredMin > 0 ? declaredMin : undefined
  const max = channel.singleMax !== undefined && channel.singleMax > 0 ? channel.singleMax : declaredMax !== undefined && declaredMax > 0 ? declaredMax : undefined
  if (min === undefined && max === undefined) return ''
  if (min !== undefined && max !== undefined && min === max) return ''
  const range = `${min ?? 0}–${max ?? '∞'}`
  // The currency is the channel's own settlement unit and belongs with the
  // range: a bare "单笔 1–50000" is an amount with no unit.
  return language === 'zh' ? `单笔 ${range} ${channel.currency ?? ''}`.trim() : `limit ${range} ${channel.currency ?? ''}`.trim()
}

function GatewayPricingTable({ prices, error, query, onQuery, language }: {
  readonly prices: readonly GatewayModelPrice[]
  readonly error: string | undefined
  readonly query: string
  readonly onQuery: (value: string) => void
  readonly language: 'zh' | 'en'
}): ReactNode {
  const normalizedQuery = query.trim().toLowerCase()
  const visible = pricingRows(prices)
  const filtered = visible
    .filter(price => normalizedQuery === '' || `${price.modelId} ${price.displayName} ${price.provider} ${price.groupName}`.toLowerCase().includes(normalizedQuery))
  // Metered rows first, free rows last and under their own heading. The table is
  // read to answer "what does this cost me", and a screen of FREE above the rows
  // that are actually billed buries that answer.
  const { metered, free } = splitPricingRows(filtered)
  const copy = language === 'zh'
    ? { kicker: '', title: '模型价格表', detail: '当前可用模型的实时价格，按后端分组的实际倍率折算；token 模型单位 USD / 1M Tokens，生图模型按张计价。', search: '搜索模型 ID、名称或分组', empty: '当前暂无可展示的模型价格。', model: '模型', group: '分组', input: '输入', output: '输出', cacheRead: '缓存读', cacheWrite: '缓存写', request: '按次', image: '按张', freeTitle: '免费模型', freeDetail: '免费模型不消耗额度，登录后即可直接调用。' }
    : { kicker: 'MODEL PRICING', title: 'Model pricing', detail: "Live prices at each backend group's effective rate: USD / 1M tokens, or per image for image-billing models.", search: 'Search model ID, name or group', empty: 'No model prices are currently available.', model: 'Model', group: 'Group', input: 'Input', output: 'Output', cacheRead: 'Cache read', cacheWrite: 'Cache write', request: 'Per request', image: 'Per image', freeTitle: 'Free models', freeDetail: 'Free models spend no credit and work as soon as you sign in.' }
  const head = <thead><tr><th>{copy.model}</th><th>{copy.group}</th><th>{copy.input}</th><th>{copy.output}</th><th>{copy.cacheRead}</th><th>{copy.cacheWrite}</th></tr></thead>
  const rowsOf = (list: readonly GatewayModelPrice[]): ReactNode => list.map(price => <tr key={pricingRowKey(price)}>
    <td><strong>{price.displayName}</strong><code>{visibleModelId(price.source, price.modelId)}</code></td>
    <td className={css.pricingGroup}><strong>{pricingGroupName(price, language)}</strong><small>{pricingGroupRate(price, language)}</small></td>
    {price.billingMode === 'image'
      ? <td className={css.pricingRequest} colSpan={4}><>{copy.image} <ImagePriceTiers tiers={price.imagePrices} currency={price.currency} source={price.source} /></></td>
      : price.billingMode === 'per-request'
      ? <td className={css.pricingRequest} colSpan={4}><>{copy.request} <PricePair current={price.perRequestPrice} original={price.originalPerRequestPrice} currency={price.currency} source={price.source} /></></td>
      : <><td><PricePair current={price.inputPricePerMillion} original={price.originalInputPricePerMillion} currency={price.currency} source={price.source} /></td><td><PricePair current={price.outputPricePerMillion} original={price.originalOutputPricePerMillion} currency={price.currency} source={price.source} /></td><td><PricePair current={price.cacheReadPricePerMillion} original={price.originalCacheReadPricePerMillion} currency={price.currency} source={price.source} /></td><td><PricePair current={price.cacheWritePricePerMillion} original={price.originalCacheWritePricePerMillion} currency={price.currency} source={price.source} /></td></>}
  </tr>)
  return <section className={css.pricingSection}>
    <div className={css.pricingHeader}><div>{copy.kicker === '' ? null : <div className={css.kicker}>{copy.kicker}</div>}<strong className={css.sectionName}>{copy.title}</strong><small className={css.sectionMeta}>{copy.detail}</small></div><input className={css.pricingSearch} value={query} onChange={(event) => { onQuery(event.target.value) }} placeholder={copy.search} aria-label={copy.search} /></div>
    {error === undefined ? null : <div className={css.pricingNotice}>{language === 'zh' ? `价格表暂不可用：${error}` : `Pricing is temporarily unavailable: ${error}`}</div>}
    <div className={css.pricingTableWrap}><table className={css.pricingTable}>{head}<tbody>{rowsOf(metered)}{metered.length === 0 ? <tr><td colSpan={6} className={css.pricingEmpty}>{free.length === 0 ? copy.empty : (language === 'zh' ? '没有需要计费的模型。' : 'No metered models.')}</td></tr> : null}</tbody></table></div>
    {free.length === 0 ? null : <div className={css.pricingFreeSection}>
      <div className={css.pricingFreeHeader}><strong>{copy.freeTitle}</strong><small className={css.sectionMeta}>{copy.freeDetail}</small></div>
      <div className={css.pricingTableWrap}><table className={css.pricingTable}>{head}<tbody>{rowsOf(free)}</tbody></table></div>
    </div>}
  </section>
}

/**
 * The per-image tiers of an image-billing row.
 *
 * The backend settles an image generation request per generated picture, priced
 * by that picture's resolution, so a single number would be wrong for two of the
 * three tiers and the token columns would be wrong for all of them. Each tier is
 * shown beside its own resolution label, and a discounted tier keeps its
 * struck-through original exactly as `PricePair` does for a token price.
 *
 * A row whose group quoted no tier says so instead of rendering an empty cell:
 * "we were not told the price" and "the price is zero" are different answers.
 */
function ImagePriceTiers({ tiers, currency, source }: { readonly tiers: readonly GatewayImagePriceTier[] | undefined; readonly currency: string; readonly source: GatewayModelPrice['source'] }): ReactNode {
  if (tiers === undefined || tiers.length === 0) return <PricePair current={undefined} original={undefined} currency={currency} source={source} />
  return <span className={css.imageTiers}>{tiers.map(tier => <span key={tier.label} className={css.imageTier}><em className={css.imageTierLabel}>{tier.label}</em><PricePair current={tier.price} original={tier.originalPrice} currency={currency} source={source} /></span>)}</span>
}

/** The cheapest quoted picture in an image-billed row, for ordering only.
 *
 * Infinity when the row quotes no tier, which sorts it below every row that
 * does quote a price — an unknown tariff is not a cheap one.
 */
function cheapestImageTier(price: GatewayModelPrice): number {
  const tiers = (price.imagePrices ?? []).map(tier => tier.price).filter(value => Number.isFinite(value))
  return tiers.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...tiers)
}

/**
 * Whether a price row costs nothing, judged only from what it quotes.
 *
 * A row is free when it quotes at least one price and every quoted price is
 * zero — the shape the backend actually sends for its free providers. A row that
 * quotes *nothing* is unknown, not free, and stays in the metered table where an
 * unreadable price reads as a dash instead of as a promise of "no charge".
 */
export function isFreePricingRow(price: GatewayModelPrice): boolean {
  // Per-image tiers count as quotes too: an image-billed row that prices every
  // picture at zero is free even though its token columns are empty.
  const quoted = [price.inputPricePerMillion, price.outputPricePerMillion, price.cacheReadPricePerMillion, price.cacheWritePricePerMillion, price.perRequestPrice, price.imageOutputPricePerMillion, ...(price.imagePrices ?? []).map(tier => tier.price)]
    .filter((value): value is number => value !== undefined && Number.isFinite(value))
  if (quoted.length === 0) return false
  return quoted.every(value => value <= 0)
}

/**
 * Split the price list into what is billed and what is not.
 *
 * The metered rows keep their incoming order (one model's groups adjacent,
 * cheapest first); the free rows keep theirs. Two stable filters are enough —
 * nothing here re-sorts, because the order of the rows is the tariff's own
 * ladder and re-ranking free rows against paid ones was the bug.
 */
export function splitPricingRows(rows: readonly GatewayModelPrice[]): { readonly metered: readonly GatewayModelPrice[]; readonly free: readonly GatewayModelPrice[] } {
  return { metered: rows.filter(price => !isFreePricingRow(price)), free: rows.filter(price => isFreePricingRow(price)) }
}

/**
 * Whether a quoted price is zero rather than merely unreadable.
 *
 * A free row and a missing price are different facts, and only the first one is
 * worth showing as FREE: `undefined` means the backend did not quote the column,
 * which `formatGatewayPrice` already renders as a dash.
 */
function isFreePrice(value: number | undefined): boolean {
  return value !== undefined && Number.isFinite(value) && value <= 0
}

function PricePair({ current, original, currency, source }: { readonly current: number | undefined; readonly original: number | undefined; readonly currency: string; readonly source: GatewayModelPrice['source'] }): ReactNode {
  // A column of `US$0.00` reads like a billing fault and buries the rows that do
  // cost money. A free tier says FREE, in the one colour that means "nothing to
  // pay" elsewhere in the panel, and the struck-through original goes with it:
  // there is no markdown on a price nobody charges.
  if (isFreePrice(current)) return <span className={css.pricePair}><strong className={css.priceFree}>FREE</strong></span>
  const currentLabel = formatGatewayPrice(current, currency)
  const showOriginal = source === 'gateway' && original !== undefined && Number.isFinite(original) && current !== undefined && Number.isFinite(current) && current < original
  return <span className={css.pricePair}>{showOriginal ? <span className={css.priceOriginal}>{formatGatewayPrice(original, currency)}</span> : null}<strong className={source === 'gateway' && original !== undefined && current !== undefined && current < original ? css.priceCurrentDiscount : css.priceCurrent}>{currentLabel}</strong></span>
}

/**
 * The identity of one rendered price row.
 *
 * A backend group's *printed name* is not its identity: the backend identifies a
 * group by its `group_id` and the table prints the name, so two rows that share
 * a name are still two tariffs — a zero-price promotion beside the same group's
 * paid route, or two account groups the backend names alike. The key therefore
 * carries the whole quoted tariff, and two rows share it exactly when they are
 * byte-identical.
 *
 * The same value keys the React list, so the fold's identity and the renderer's
 * cannot drift: a key two rendered rows shared would let the second paint over
 * the first one's cells.
 */
export function pricingRowKey(price: GatewayModelPrice): string {
  return JSON.stringify([
    price.source, price.modelId, price.groupName, price.platform ?? '', price.rateMultiplier, price.billingMode, price.currency,
    price.inputPricePerMillion ?? null, price.outputPricePerMillion ?? null,
    price.cacheReadPricePerMillion ?? null, price.cacheWritePricePerMillion ?? null,
    price.perRequestPrice ?? null, price.imageOutputPricePerMillion ?? null,
    price.originalInputPricePerMillion ?? null, price.originalOutputPricePerMillion ?? null,
    price.originalCacheReadPricePerMillion ?? null, price.originalCacheWritePricePerMillion ?? null,
    price.originalPerRequestPrice ?? null, price.originalImageOutputPricePerMillion ?? null,
    (price.imagePrices ?? []).map(tier => [tier.label, tier.price, tier.originalPrice ?? null]),
  ])
}

/**
 * The rows the pricing table renders: one per backend group.
 *
 * The backend prices a model *per group*, and the same model is routinely
 * offered through several groups at different rates — the host returns one row
 * per (model, group). Folding those rows into a single tariff per model, as
 * this table once did, deleted every group name and every rate but the
 * cheapest one. Only a byte-identical row is folded away.
 */
export function pricingRows(prices: readonly GatewayModelPrice[]): readonly GatewayModelPrice[] {
  return Array.from(prices.reduce((result, price) => {
    // One model's groups stay adjacent, cheapest first, so the rows are ordered
    // rather than merely deduped.
    result.set(pricingRowKey(price), price)
    return result
  }, new Map<string, GatewayModelPrice>()).values()).sort(comparePricingRows)
}

function pricingSortValue(price: GatewayModelPrice): number {
  if (price.source !== 'gateway') return -1
  if (price.billingMode === 'per-request') return price.perRequestPrice ?? Number.POSITIVE_INFINITY
  // An image row is billed per picture, so its token columns are not a price at
  // all. Rank it by its cheapest tier: the table orders tariffs cheapest-first,
  // and the cheapest picture is what answers "what does this cost me".
  if (price.billingMode === 'image') return cheapestImageTier(price)
  return (price.inputPricePerMillion ?? 0) + (price.outputPricePerMillion ?? 0)
}

/**
 * Keep one model's groups adjacent, cheapest first, in a stable order.
 *
 * The same model is sold through several backend groups at different rates, so
 * the group — not the row position — is what tells two tariffs appart. Ties
 * fall back to the group name so a deployment publishing two groups at the
 * same rate still renders the same way twice.
 */
export function comparePricingRows(left: GatewayModelPrice, right: GatewayModelPrice): number {
  return left.displayName.localeCompare(right.displayName, 'zh-Hans-CN')
    || left.modelId.localeCompare(right.modelId)
    || pricingSortValue(left) - pricingSortValue(right)
    || left.groupName.localeCompare(right.groupName, 'zh-Hans-CN')
}

/**
 * The backend's own group name for a price row.
 *
 * `accountGatewayModelPrices` copies `options[].group_name` straight out of
 * `/models/options`, so this is the account's real plan name rather than a
 * label this client invented, and it is what makes a model listed twice
 * readable. Direct/free providers have no gateway group — their `groupName`
 * already carries their own name — so the source label is only the fallback
 * for an empty one.
 */
export function pricingGroupName(price: GatewayModelPrice, language: 'zh' | 'en'): string {
  const name = price.groupName.trim()
  return name === '' ? priceSourceLabel(price.source, language) : name
}

/**
 * The group's effective rate, shown beside it.
 *
 * The row's prices already have this rate folded in (`accountGatewayModelPrices`
 * scales the published tariff), so it is reported here rather than applied a
 * second time. `0` is the backend's free signal and reads as free.
 */
export function pricingGroupRate(price: GatewayModelPrice, language: 'zh' | 'en'): string {
  if (price.rateMultiplier === 0) return language === 'zh' ? '免费' : 'Free'
  if (!Number.isFinite(price.rateMultiplier)) return ''
  return `×${price.rateMultiplier}`
}

function priceSourceLabel(source: GatewayModelPrice['source'], language: 'zh' | 'en'): string {
  const labels: Record<GatewayModelPrice['source'], readonly [string, string]> = {
    gateway: ['FreeCodeGo 网关', 'FreeCodeGo gateway'],
    vyce: ['VyceAI（签到额度抵扣）', 'VyceAI (check-in credit)'],
    empero: ['FreeCodeGo 兼容模型', 'FreeCodeGo compatible model'],
    opencode: ['OpenCode 免费模型', 'OpenCode free model'],
    openrouter: ['OpenRouter 免费模型', 'OpenRouter free model'],
    logfare: ['logfare 免费模型', 'logfare free model'],
    workbuddy: ['WorkBuddy 免费模型', 'WorkBuddy free model'],
    agnes: ['Agnes 免费模型', 'Agnes free model'],
    sensenova: ['SenseNova 公测免费模型', 'SenseNova public-beta free model'],
    nvidia: ['NVIDIA NIM 免费模型', 'NVIDIA NIM free model'],
  }
  return (labels[source] ?? ['模型价格', 'Model price'])[language === 'zh' ? 0 : 1]
}

function paymentAmountForCredit(creditUsd: number, channel: PaymentChannel | undefined): number {
  if (channel === undefined) throw new Error('FreeCodeGo payment channel is required')
  const multiplier = channel.balanceRechargeMultiplier
  if (multiplier === undefined || !Number.isFinite(multiplier) || multiplier <= 0) throw new Error(`FreeCodeGo payment channel ${channel.paymentType} has no valid balance multiplier`)
  return roundUpCurrency(creditUsd / multiplier, channel.currency)
}

function paymentTotalForCredit(creditUsd: number, channel: PaymentChannel | undefined): number {
  const base = paymentAmountForCredit(creditUsd, channel)
  const percentage = channel?.feeRate !== undefined && channel.feeRate > 0
    ? roundUpCurrency(base * channel.feeRate / 100, channel.currency)
    : 0
  const fixed = channel?.fixedFee !== undefined && channel.fixedFee > 0 ? roundUpCurrency(channel.fixedFee, channel.currency) : 0
  return roundUpCurrency(base + percentage + fixed, channel?.currency)
}

function formatCheckoutLabel(creditUsd: number | undefined, channel: PaymentChannel | undefined, checkoutLabel: string): string {
  if (creditUsd === undefined || !Number.isFinite(creditUsd) || channel === undefined) return checkoutLabel
  const total = paymentTotalForCredit(creditUsd, channel)
  return `${checkoutLabel} · ${formatMoney(total, channel.currency)}`
}


/**
 * The provider authorization link (Cline device login, WorkBuddy sign-in).
 *
 * The URL arrives from the provider — the same value the Host hands to the
 * system browser — so it runs the same allow-list the opener applies: a
 * `javascript:` (or any non-http) value from a hostile or compromised response
 * must not become code running in the Settings origin one click later. A
 * refused value drops the `href`, which leaves the step visible but inert
 * rather than offering a link that cannot be opened.
 */
function safeAuthorizationUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : undefined
  } catch { return undefined }
}

/**
 * The order panel's manual handoff link. It runs the same allow-list as the
 * automatic open: a URL this panel refuses to open must not become clickable
 * just because the user pressed the button instead of the browser.
 */
/** The order card's manual link, using the same URL guard as the dialog. */
function PaymentCheckoutLink({ value, label }: { readonly value: string | undefined; readonly label: string }): ReactNode {
  const url = safeCheckoutUrl(value)
  if (url === undefined) return null
  return <a href={url} target="_blank" rel="noreferrer">{label}</a>
}

/**
 * The payload shown when a QR code arrives as text rather than as an image.
 *
 * The button carries one language, and it names the action rather than repeating
 * the payload's label: it used to read "支付二维码 · 复制内容 / Copy" to everybody,
 * which is a bilingual control in a panel that already knows which language it is
 * drawing in.
 */
function PaymentQrCode({ value, label, language }: { readonly value: string; readonly label: string; readonly language: 'zh' | 'en' }): ReactNode {
  return <div className={css.qrWrap}><code className={css.qrText}>{value}</code><button className={css.button} type="button" title={label} onClick={() => { void globalThis.navigator?.clipboard?.writeText(value) }}>{language === 'zh' ? '复制二维码内容' : 'Copy the QR contents'}</button></div>
}

/**
 * This client's own abort, as the runtimes spell it — and nothing else.
 *
 * The distinction matters because the two failures mean opposite things. An
 * abort is *us* giving up on a request the backend may still have completed, so
 * an order can exist unseen. A provider timeout reported *inside* a 5xx body is
 * the backend reaching the payment provider and the provider failing, which
 * creates no order and is answered with "not available, retry".
 *
 * Matching the bare word `timeout` collapsed those two: a `503` whose nested
 * gateway error happened to say "context deadline exceeded / Timeout exceeded
 * while awaiting headers" was reported as our own abort, pointing the user at a
 * pending order that was never created.
 *
 * What these messages deliberately do *not* carry is the backend's own detail
 * string. It names internal routes, provider hosts and parser failures
 * (`easypay parse: invalid character '<' ...`), which is operator information a
 * customer cannot act on and should not be reading. Each branch therefore ends
 * at the sentence: what happened, and what to try next.
 */
const CLIENT_ABORT_PATTERN = /aborted due to timeout|the operation was aborted|AbortError/u

export function describePaymentError(detail: string, language: 'zh' | 'en'): string {
  // One sentence, in the language this panel is drawing in. It used to return a
  // "中文 / English" pair, which handed every reader a sentence in a language
  // they did not pick — and made the line twice as long as the fact it carried.
  // The caller's own language is already known here, so the choice is made once.
  const zh = language === 'zh'
  const value = detail.trim()
  if (value === '') return zh ? '订单请求失败，请稍后重试。' : 'The order request failed; try again later.'
  // A timeout on a money path is a *different* fact from "the service is down",
  // and it must not be answered with a blind retry: the request timed out
  // waiting for the provider, so the backend may already hold an order this
  // client never learned the id of. Telling the user to retry is how duplicate
  // pending orders pile up until the account hits its pending-order limit — so
  // this branch names the pending list instead, and it is checked before the
  // generic 5xx/network branch below, which would swallow it.
  if (CLIENT_ABORT_PATTERN.test(value)) return zh ? '支付服务超时未返回结果。这笔订单可能已经创建但还没有支付链接，请先在上方「待支付订单」里确认（继续支付或取消），再决定是否重新下单。' : 'The payment service did not answer in time. This order may already exist without a payment link — check the pending orders above first (pay it or cancel it) before ordering again.'
  if (/INVALID_STATUS|cannot be cancelled in current status/i.test(value)) return zh ? '订单状态已变化，只有待支付的订单可以取消。请重新打开设置面板查看最新状态。' : 'This order has already changed state; only a pending order can be cancelled. Reopen the settings panel to see its current state.'
  if (/too_many_pending|TOO_MANY_PENDING|429/i.test(value)) return zh ? '待支付订单数量已达上限，请先取消一笔未完成的订单。' : 'Too many orders are still awaiting payment; cancel one of them first.'
  if (/INVALID_RETURN_URL|return_url/i.test(value)) return zh ? '支付没能开始，请稍后重试或改用其他支付方式。' : 'The payment could not start; try again in a moment, or use another payment method.'
  if (/PAYMENT_DISABLED|payment system is disabled/i.test(value)) return zh ? '支付服务当前未启用。' : 'Payments are currently unavailable.'
  // `NO_AVAILABLE_INSTANCE` (nothing is configured for this type) and
  // `PAYMENT_GATEWAY_ERROR` (an instance exists and the upstream provider did not
  // answer) are different backend conditions, but they meet in the same place
  // for the user: 支付宝 / 微信 are served by a mainland-only provider (易支付). From outside
  // China — or through any proxy, VPN or overseas exit node — that provider
  // answers with an HTML error page instead of an API response, which is why the
  // advice here is about the *network*, not about the button the user just
  // pressed. The card channel has no such restriction, so it is offered as the
  // way through.
  if (/NO_AVAILABLE_INSTANCE|no available instance|no available gateway/i.test(value)) return zh ? '这种支付方式暂时无法下单。支付宝与微信支付只支持中国大陆网络，请关闭代理或 VPN 后重试；也可以改用银行卡或信用卡支付。' : 'This payment method cannot be used right now. Alipay and WeChat Pay only work on mainland China networks — turn off any proxy or VPN and try again, or pay by bank card or credit card.'
  if (/PAYMENT_GATEWAY_ERROR|payment gateway error/i.test(value)) return zh ? '支付通道暂时没有响应，通常是网络环境或通道维护导致的，与你的账户无关。支付宝与微信支付请先关闭代理或 VPN 后重试；也可以改用银行卡或信用卡支付，或稍后再试。' : 'The payment channel is not responding — usually the network path or provider maintenance, not your account. For Alipay and WeChat Pay, turn off any proxy or VPN and retry; you can also pay by bank card or credit card, or try again later.'
  if (/INVALID_AMOUNT|amount out of range/i.test(value)) return zh ? '充值金额不在允许范围内。' : 'That recharge amount is outside the allowed range.'
  if (/HTTP\s+401|unauthori[sz]ed|token.*expir/i.test(value)) return zh ? '登录状态已失效，请重新登录后重试。' : 'Your sign-in has expired; sign in again and retry.'
  if (/HTTP\s+403|forbidden|permission|not allowed/i.test(value)) return zh ? '当前账户不能创建充值订单。' : 'This account cannot create orders.'
  if (/HTTP\s+404|not found/i.test(value)) return zh ? '订单服务暂时不可用，请稍后重试。' : 'The order service is unavailable right now; try again later.'
  if (/HTTP\s+400|bad request|invalid/i.test(value)) return zh ? '支付方式或订单信息未被接受，请换一种支付方式后重试。' : 'The payment method or the order details were not accepted; try another payment method.'
  if (/HTTP\s+409|conflict|duplicate/i.test(value)) return zh ? '订单状态发生冲突，请重新打开设置面板后再试。' : 'The order is in a conflicting state; reopen the settings panel and retry.'
  if (/HTTP\s+5\d\d|timeout|timed out|network/i.test(value)) return zh ? '支付服务暂时不可用，请稍后重试。' : 'The payment service is temporarily unavailable; try again later.'
  if (/no checkout URL|no payment URL|QR code/i.test(value)) return zh ? '支付服务没有返回可用的支付链接或二维码，请换一种支付方式或稍后重试。' : 'The payment service returned no usable payment link or QR code; try another payment method or try again later.'
  return zh ? '订单操作失败，请稍后重试。' : 'The order operation failed; try again later.'
}

/**
 * Every order row the endpoint returned, normalized.
 *
 * Split out of {@link parsePendingOrders} so the pending view and the checkout
 * result share one reading of the same response: a second parser would drift
 * from the first.
 */
function parsePaymentOrders(value: unknown): readonly PaymentOrder[] {
  const root = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  const nested = root?.data !== null && typeof root?.data === 'object' && !Array.isArray(root?.data) ? root.data as Record<string, unknown> : undefined
  const raw = Array.isArray(value)
    ? value
    : Array.isArray(root?.items) ? root.items
      : Array.isArray(root?.orders) ? root.orders
        : Array.isArray(root?.results) ? root.results
          : Array.isArray(nested?.items) ? nested.items
            : Array.isArray(nested?.orders) ? nested.orders
              : undefined
  if (raw === undefined) throw new Error('FreeCodeGo payment orders response must contain an orders array')
  const parsed = raw.map((item) => {
    if (item === null || typeof item !== 'object') throw new Error('FreeCodeGo payment order must be an object')
    const row = item as Record<string, unknown>
    const id = row.id ?? row.order_id
    const state = row.status ?? row.state
    const amountValue = row.amount ?? row.pay_amount
    const amount = typeof amountValue === 'number' ? amountValue : typeof amountValue === 'string' ? Number(amountValue) : Number.NaN
    if ((typeof id !== 'number' && typeof id !== 'string') || typeof state !== 'string' || !Number.isFinite(amount)) throw new Error('FreeCodeGo payment order id, state, and amount are required')
    const currency = row.currency
    if (typeof currency !== 'string' || currency.trim() === '') throw new Error(`FreeCodeGo payment order ${String(id)} currency is required`)
    // The two stamps are carried apart rather than collapsed into one, because
    // they answer different questions and one of them is the one a payment list is
    // read for. Each is set only when the backend sent it: a row carrying neither
    // renders without a date rather than with today's. `orderReceiptStamp` decides
    // which one a receipt row states.
    const createdAt = typeof row.created_at === 'string' && row.created_at.trim() !== '' ? row.created_at : undefined
    const paidAt = typeof row.paid_at === 'string' && row.paid_at.trim() !== '' ? row.paid_at : undefined
    return { orderId: String(id), state, amount, currency, ...(typeof row.pay_amount === 'number' ? { payAmount: row.pay_amount } : typeof row.pay_amount === 'string' && Number.isFinite(Number(row.pay_amount)) ? { payAmount: Number(row.pay_amount) } : {}), ...(typeof row.out_trade_no === 'string' ? { outTradeNo: row.out_trade_no } : {}), ...(typeof row.payment_type === 'string' ? { paymentType: row.payment_type } : {}), ...(typeof row.expires_at === 'string' ? { expiresAt: row.expires_at } : {}),    ...(createdAt === undefined ? {} : { createdAt }), ...(paidAt === undefined ? {} : { paidAt }), ...(typeof row.receipt_available === 'boolean' ? { receiptAvailable: row.receipt_available } : {}), ...(typeof row.stripe_receipt_available === 'boolean' ? { stripeReceiptAvailable: row.stripe_receipt_available } : {}) }
  })
  return parsed
}

function parsePendingOrders(value: unknown): readonly PaymentOrder[] {
  return parsePaymentOrders(value).filter(order => canCancelPaymentOrder(order))
}

/**
 * Every order in the response whose receipt the backend will serve.
 *
 * The list is the account's payment history, so it is filtered by what the
 * backend will actually hand back rather than by a state list kept here: an
 * offered row that then fails on click is worse than an absent one, and the
 * backend answers a state this module does not track — its vocabulary is wider
 * than the four states the panel requests, because this product sells no refunds
 * and never asks for the refund family that would be the live example.
 */
function parseReceiptOrders(value: unknown): readonly PaymentOrder[] {
  return parsePaymentOrders(value).filter(order => orderReceiptAvailable(order))
}

/**
 * The states a payment settles into when the response carries no receipt flag.
 *
 * `recharging` belongs with the other two rather than with the pending ones: the
 * backend only enters it after the money arrived, while credits are being
 * applied.
 */
const RECEIPT_ORDER_STATES: ReadonlySet<string> = new Set(['paid', 'recharging', 'completed'])

/**
 * Whether this order has a receipt to download.
 *
 * The backend's flag when it sent one, because it is the authority on which
 * orders have a document; the settled-state fallback is for a Host whose list
 * rows predate the flag and would otherwise offer nothing at all.
 * @param order - the order row to judge.
 * @returns true when a receipt download should be offered.
 */
export function orderReceiptAvailable(order: Pick<PaymentOrder, 'state' | 'receiptAvailable'> | undefined): boolean {
  if (order === undefined) return false
  return order.receiptAvailable ?? RECEIPT_ORDER_STATES.has(order.state.trim().toLowerCase())
}

/**
 * Whether to draw the Stripe download for one order, on either surface.
 *
 * The rule is deliberately the backend's alone. It knows which payments Stripe
 * took, and it is what issues the document, so a guess here from `paymentType`
 * would be a second authority that can disagree about whether a file exists. An
 * **absent** flag is not a yes: the create-order response carries no receipt
 * flags for an order nobody has paid, and drawing the button there would offer a
 * download the backend would refuse.
 *
 * Both the receipt list's rows and the open order's card ask this one question,
 * so the two cannot drift into offering different sets.
 * @param order - the order row or the current order, whichever surface is asking.
 * @param fetch - the Host's Stripe read, when this deployment registered one.
 * @returns true when the Stripe download should be offered.
 */
export function stripeReceiptOffered(
  order: Pick<PaymentOrder, 'stripeReceiptAvailable'> | undefined,
  fetch: ((orderId: string) => Promise<RemoteResult<ReceiptDocument>>) | undefined,
): boolean {
  return fetch !== undefined && order?.stripeReceiptAvailable === true
}


function canCancelPaymentOrder(order: Pick<PaymentOrder, 'state'> | undefined): boolean {
  return order?.state.trim().toLowerCase() === 'pending'
}
