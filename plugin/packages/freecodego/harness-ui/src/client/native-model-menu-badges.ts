/**
 * Presentation-only metadata for the stock Harness model menu.
 *
 * The official selector remains the owner of selection, focus, scrolling, and
 * reasoning effort. This layer only appends non-interactive labels to model
 * rows that expose the stable ARIA menu contract.
 */

type NativeModel = {
  readonly id: string
  readonly name: string
  readonly description?: string
}

type NativeModelGroup = {
  readonly id: string
  readonly name: string
  readonly models: readonly NativeModel[]
}

export interface NativeModelDirectorySnapshot {
  readonly groups: readonly NativeModelGroup[]
  readonly current?: { readonly provider: string; readonly model: string } | null
}

type MenuLanguage = 'zh' | 'en'

interface ModelPresentation {
  readonly source: string
  readonly access: 'free' | 'training' | 'multiplier'
  readonly multiplier?: string
  readonly health?: { readonly status: 'operational' | 'degraded' | 'unknown'; readonly latencyMs?: number; readonly uptimePercent?: number; readonly window?: '1h' | '7d' | '30m' }
}

interface BadgePresentation {
  readonly kind: 'free' | 'training' | 'multiplier' | 'healthy' | 'degraded' | 'unknown' | 'unavailable'
  readonly label: string
}

interface ModelAvailability {
  readonly available: boolean
  readonly reason?: string
}

export interface NativeModelMenuBadgesOptions {
  /** Read the official picker directory at decoration time. */
  readonly snapshot: () => NativeModelDirectorySnapshot | undefined
  /** Read the current shell language without owning the shell locale. */
  readonly language: () => MenuLanguage
  /** Host-owned credential and provider availability, keyed by provider/model. */
  readonly availability?: () => ReadonlyMap<string, ModelAvailability>
}

type CollapseState = Map<string, boolean>
type MenuWidthPins = WeakMap<HTMLElement, { readonly width: number; readonly signature: string }>
type GroupOrderState = WeakMap<HTMLElement, { readonly signature: string }>

const FREE_SOURCES = new Set(['opencode', 'openrouter', 'logfare', 'mystery provider', 'mystery provider 2'])

/**
 * Official picker class names this decorator has to discover by substring.
 *
 * The picker emits CSS-module class names, so its DOM carries a hashed suffix
 * and no attribute to select on. These substrings are the coupling to that
 * component, collected here so a rename upstream is one edit instead of a hunt
 * through the file. Everything this decorator stamps itself is keyed on its own
 * `data-fcg-*` attributes instead, and every lookup below prefers those: a class
 * probe only runs the first time a row is decorated, never on a re-render.
 */
const UPSTREAM_PICKER_CLASS = {
  /** The row's text column, and the name element inside it. */
  copy: '[class*="optionCopy"]',
  name: '[class*="modelName"], [class*="optionName"]',
  /**
   * A billing lane ("FREE"/multiplier) the picker would render. The pinned
   * baseline's picker renders none, so this probe matches nothing today. It
   * stays because the lane belongs to the picker rather than to this decorator,
   * and clearing it is the only way not to echo a billing claim the decorator
   * cannot verify for a user-configured provider.
   */
  meta: '[class*="optionMeta"]',
} as const

/** Per-provider accent for the picker's group headings.
 *
 * Every provider heading previously rendered in the same primary ink as the
 * model rows, so scanning the menu meant reading every label. A distinct hue
 * per provider turns the heading into a landmark; an unconfigured provider
 * overrides the accent with the disabled grey so its whole section reads as
 * inert while its rows stay expandable. */
const PROVIDER_ACCENTS: Readonly<Record<string, string>> = {
  freecodego: 'var(--fcg-brand, #2563eb)',
  vyce: '#7c3aed',
  logfare: '#059669',
  opencode: '#d97706',
  sensenova: '#db2777',
  nvidia: '#65a30d',
  agnes: '#0891b2',
  workbuddy: '#9333ea',
  cline: '#ea580c',
}

function providerAccent(provider: string): string {
  return PROVIDER_ACCENTS[provider] ?? 'var(--dsw-alias-label-primary, #111)'
}

/** Providers this plugin registers itself. Every picker group whose id is not
 * in this set was configured by the user (a custom third-party API route), so
 * the plugin cannot know whether its routes are free or metered — neither
 * badge may be asserted for them. The gateway also always sorts first: it is
 * the house provider, while user providers belong below the built-ins. */
const BUILTIN_PROVIDER_IDS = new Set(['freecodego', 'prem', 'vyce', 'opencode', 'openrouter', 'logfare', 'sensenova', 'nvidia', 'agnes', 'workbuddy', 'cline', 'trae', 'empero'])

function isUserProvider(provider: string | undefined): boolean {
  return provider !== undefined && !BUILTIN_PROVIDER_IDS.has(provider)
}

function compact(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

/** Keep provider-qualified IDs usable internally while showing concise names. */
function stripLogfarePrefix(value: string): string {
  return value.replace(/^logfare\//iu, '')
}

function isLogfareProvider(provider: string | undefined): boolean {
  return provider?.trim().toLowerCase() === 'logfare'
}

/** Claude routes remain available to the backend, but are not advertised in
 * the native text-model picker for the logfare provider. */
function isHiddenLogfareTextModel(provider: string | undefined, model: NativeModel): boolean {
  if (!isLogfareProvider(provider)) return false
  return /claude/iu.test(`${model.id} ${model.name}`)
}

function visibleModelLabel(provider: string | undefined, model: NativeModel, fallback: string): string {
  const value = compact(model.name || fallback)
  return isLogfareProvider(provider) ? stripLogfarePrefix(value) : value
}

function presentationOf(model: NativeModel): ModelPresentation | undefined {
  const description = model.description
  const source = compact(description?.split('·', 1)[0] ?? '')
  const normalizedSource = source.toLowerCase()
  const multipliers = description === undefined
    ? []
    : [...description.matchAll(/(?:×|x)\s*(\d+(?:\.\d+)?)/giu)]
      .map(match => Number(match[1]))
      .filter(value => Number.isFinite(value))

  const health = healthOf(description)
  if (description?.includes('tag:training') === true) return { source, access: 'training', ...(health === undefined ? {} : { health }) }
  if (multipliers.some(value => value === 0) || FREE_SOURCES.has(normalizedSource)) return { source, access: 'free', ...(health === undefined ? {} : { health }) }

  const paid = [...new Set(multipliers.filter(value => value > 0))]
  if (paid.length === 0) return undefined
  return { source, access: 'multiplier', multiplier: paid.map(value => `×${value}`).join(' / '), ...(health === undefined ? {} : { health }) }
}

function healthOf(description: string | undefined): ModelPresentation['health'] | undefined {
  const value = description ?? ''
  const status = /health:(operational|degraded|unknown)/u.exec(value)?.[1]
  if (status === undefined) return undefined
  if (status !== 'operational' && status !== 'degraded' && status !== 'unknown') return undefined
  const uptimeValue = /uptime:([0-9.]+|na)/u.exec(value)?.[1]
  const uptime = uptimeValue === undefined || uptimeValue === 'na' ? undefined : Number(uptimeValue)
  if (uptime !== undefined && (!Number.isFinite(uptime) || uptime < 0 || uptime > 100)) return undefined
  const latencyValue = /latency:([0-9.]+|na)/u.exec(value)?.[1]
  const latency = latencyValue === undefined || latencyValue === 'na' ? undefined : Number(latencyValue)
  if (latency !== undefined && (!Number.isFinite(latency) || latency < 0)) return undefined
  const window = /window:(1h|7d|30m)/u.exec(value)?.[1]
  return { status, ...(latency === undefined ? {} : { latencyMs: latency }), ...(uptime === undefined ? {} : { uptimePercent: uptime }), ...(window === '1h' || window === '7d' || window === '30m' ? { window } : {}) }
}

function unavailableMessage(reason: string | undefined, language: MenuLanguage): string {
  const zh = language === 'zh'
  switch (reason) {
    case 'SENSENOVA_API_KEY_REQUIRED': return zh ? '请先在设置中填写 SenseNova API Key' : 'Configure a SenseNova API key in Settings first'
    // The key is configured but the provider refused it. Distinct from a missing
    // credential: telling the user to "configure a key" again would send them to
    // re-enter what is already there.
    case 'SENSENOVA_API_KEY_REJECTED': return zh ? 'SenseNova 拒绝了这个 API Key，请在设置中更换' : 'SenseNova rejected this API key; replace it in Settings'
    // NVIDIA shares SenseNova's listing path (`managed-catalogs.ts` returns its
    // static free roster with this reason when the key is absent), so it needs
    // the same "which key" sentence. Without it the row fell to the generic
    // "unavailable" wording and named no provider to go and configure.
    case 'NVIDIA_API_KEY_REQUIRED': return zh ? '请先在设置中填写 NVIDIA API Key' : 'Configure an NVIDIA API key in Settings first'
    case 'NVIDIA_API_KEY_REJECTED': return zh ? 'NVIDIA 拒绝了这个 API Key，请在设置中更换' : 'NVIDIA rejected this API key; replace it in Settings'
    case 'OPENROUTER_API_KEY_REQUIRED': return zh ? '请先在设置中填写 OpenRouter API Key' : 'Configure an OpenRouter API key in Settings first'
    case 'VYCE_API_KEY_REQUIRED': return zh ? '请先在设置中填写 VyceAI API Key' : 'Configure a VyceAI API key in Settings first'
    case 'LOGFARE_API_KEY_REQUIRED': return zh ? '请先在设置中配置此提供商的 API Key' : 'Configure this provider API key in Settings first'
    // The key is configured; the route is held back because the account has not
    // consented to the provider's training-data programme. Distinct from a
    // missing credential, and the only fix is a different switch than the key
    // field: without its own sentence the row is a hard gate whose tooltip says
    // only "unavailable", which is the state the producer's own thrown error
    // exists to explain — and the picker disables the row, so that error can
    // never be reached by the user who has to act on it.
    case 'LOGFARE_PREMIUM_OPT_IN_REQUIRED': return zh ? '请先在设置中开启此提供商的训练数据授权' : 'Enable this provider\u2019s training-data consent in Settings first'
    case 'AGNES_API_KEY_REQUIRED': return zh ? '请先在设置中创建 Agnes API Key' : 'Create an Agnes API key in Settings first'
    case 'AGNES_LOGIN_REQUIRED': return zh ? '请先登录 Agnes' : 'Sign in to Agnes first'
    case 'WORKBUDDY_LOGIN_REQUIRED': return zh ? '请先登录 WorkBuddy' : 'Sign in to WorkBuddy first'
    case 'TRAE_LOGIN_REQUIRED': return zh ? '请先登录 Trae' : 'Sign in to Trae first'
    case 'FREECODEGO_LOGIN_REQUIRED': return zh ? '请先登录 FreeCodeGo' : 'Sign in to FreeCodeGo first'
    // A group row the account cannot bill through. Distinct from a missing
    // credential: the route is reachable, the account is not entitled to it.
    case 'FREECODEGO_GROUP_LOCKED': return zh ? '该分组需解锁后才能使用' : 'Unlock this group before using it'
    case 'FREECODEGO_GROUP_UNAVAILABLE': return zh ? '该分组当前不可用，可改用同模型的其他分组' : 'This group is currently unavailable; pick another group for this model'
    case 'CLINE_LOGIN_REQUIRED': return zh ? '请先在设置中添加 Cline 账号' : 'Add a Cline account in Settings first'
    case 'CLINE_MODEL_RATE_LIMITED': return zh ? '该模型的 Cline 免费额度已用完（额度按模型计算），可改用 Cline 其他免费模型或稍后重试' : 'This model\u2019s Cline free budget is spent (budgets are per model); use another Cline free model or retry later'
    case 'MODEL_PROVIDER_DEGRADED': return zh ? '该模型当前服务异常，请稍后重试或选择其他模型' : 'This model is currently degraded; try again later or choose another model'
    default: return zh ? '此模型当前不可用' : 'This model is currently unavailable'
  }
}

/** Give a row back the native state this decorator took from it. */
function restoreGate(row: HTMLButtonElement): void {
  const originalDisabled = row.dataset.fcgModelOriginalDisabled === 'true'
  delete row.dataset.fcgModelUnavailable
  delete row.dataset.fcgModelUnavailableReason
  delete row.dataset.fcgModelOriginalDisabled
  row.removeAttribute('aria-disabled')
  row.disabled = originalDisabled
}

/**
 * Badges shown beside one model row in the native picker.
 *
 * Pricing and health are deliberately not surfaced here. The menu is a picker,
 * not a status board: a "free" tag beside a row the user has already chosen to
 * use is noise, and a health percentage changes by the minute, so it competes
 * with the model name for attention while carrying no decision value. The badge
 * kept is the one that changes what the user must *do* — a route that needs
 * credentials before it will work, or one the user can only wait out.
 */
/** Reasons that report the route's *health* rather than a missing credential.
 *
 * Both codes fire on a provider health reading, not on absent configuration:
 * logfare sets `MODEL_PROVIDER_DEGRADED` for a zero-uptime model in the current
 * 1h window (`managed-catalogs.ts`, `listLogfareTextModels`), and OpenCode sets
 * `OPENCODE_MODEL_UNAVAILABLE` for a model whose health status is `degraded`
 * (`managed-catalogs.ts`, `listOpenCodeModels`). Neither is fixable in
 * Settings, and both clear on the provider's own schedule. */
const DEGRADED_ROUTE_REASONS = new Set(['MODEL_PROVIDER_DEGRADED', 'OPENCODE_MODEL_UNAVAILABLE'])

/** Badge text for a disabled row, keyed by why it is disabled.
 *
 * A locked or switched-off backend group is not a missing credential: the row
 * exists and the account simply cannot bill through it, so the generic
 * "setup required" label would send the user to a settings page with nothing
 * to fix. A degraded route is the same mistake one step further out — the
 * provider is configured and every other model on it stays usable, only this
 * route's health is down — so "no longer selectable right now" is what the row
 * should say. The reason codes mirror the Host's `MODEL_REASON_*`/
 * `GROUP_*_REASON` constants; the web client spells them out because it cannot
 * import the Host bundle, so renaming one on either side silently downgrades
 * that row to the generic label. */
function unavailableLabel(reason: string | undefined, language: MenuLanguage): string {
  // A credential the provider refused is configured, not missing: the badge has
  // to send the user to replace it, which SETUP REQUIRED does not say.
  if (reason === 'SENSENOVA_API_KEY_REJECTED' || reason === 'NVIDIA_API_KEY_REJECTED') return language === 'zh' ? '凭据被拒' : 'KEY REJECTED'
  if (reason === 'CLINE_MODEL_RATE_LIMITED') return language === 'zh' ? '限流' : 'RATE LIMITED'
  if (reason === 'FREECODEGO_GROUP_LOCKED') return language === 'zh' ? '需解锁' : 'LOCKED'
  if (reason === 'FREECODEGO_GROUP_UNAVAILABLE') return language === 'zh' ? '不可用' : 'UNAVAILABLE'
  if (reason !== undefined && DEGRADED_ROUTE_REASONS.has(reason)) return language === 'zh' ? '暂不可选' : 'DEGRADED'
  return language === 'zh' ? '需配置' : 'SETUP REQUIRED'
}

function labels(language: MenuLanguage, availability: ModelAvailability | undefined): readonly BadgePresentation[] {
  // A multiplier is kept: it states what the route costs, which is a real
  // decision input. It must be derived from `access`, not from the optional
  // `multiplier` string: a free route carries `access: 'free'` with no
  // multiplier value, so keying off the string would render *nothing* for the
  // cheapest models — the exact opposite of useful.
  //
  // The free and health tags are dropped. Neither changes what the user does:
  // they are already looking at this row, and a health reading changes by the
  // minute.
  // The official picker now renders access/pricing metadata in its own
  // trailing lane. Do not add a second FREE or multiplier badge here: doing
  // so creates the duplicated green labels seen in the menu. This decorator
  // keeps only metadata the official row cannot own (setup).
  // A spent free budget is not "needs setup": the credential is fine, only this
  // route is out until its budget resets. Same disabled row, honest badge.
  const unavailable: BadgePresentation | undefined = availability?.available === false
    ? { kind: 'unavailable', label: unavailableLabel(availability.reason, language) }
    : undefined
  return [unavailable].filter((badge): badge is BadgePresentation => badge !== undefined)
}

function groupName(group: Element): string {
  const labelledBy = group.getAttribute('aria-labelledby')
  if (labelledBy === null) return ''
  const heading = document.getElementById(labelledBy)
  return compact(heading?.dataset.fcgModelGroupName ?? heading?.textContent ?? '')
}

/**
 * Resolve a rendered group to its provider.
 *
 * Two providers used to render under the same heading, and this returned
 * `undefined` on any duplicate — which silently disabled the whole decorator
 * for those groups: no heading became a toggle, so the collapsed-by-default
 * rule force-expanded them with no way to close, and the plugin's heading
 * styling never applied.
 *
 * The picker builds each heading id as `${reactId}-${group.id}`, and the group
 * id *is* the provider key, so the id suffix identifies the provider even when
 * display names collide. The name match stays as a fallback for markup that
 * carries no such suffix.
 */
function providerForGroup(snapshot: NativeModelDirectorySnapshot, group: Element): string | undefined {
  const headingId = group.getAttribute('aria-labelledby') ?? ''
  if (headingId !== '') {
    const suffix = headingId.split('-').at(-1)
    const exactSuffix = snapshot.groups.find(candidate => candidate.id === suffix)
    if (exactSuffix !== undefined) return exactSuffix.id
    const byHeading = snapshot.groups.filter(candidate => headingId === candidate.id || headingId.endsWith(`-${candidate.id}`))
    if (byHeading.length === 1) return byHeading[0]!.id
  }
  const name = groupName(group)
  const matches = snapshot.groups.filter(candidate => compact(candidate.name) === name)
  return matches.length === 1 ? matches[0]!.id : undefined
}

function modelForRow(snapshot: NativeModelDirectorySnapshot, group: Element, label: string): NativeModel | undefined {
  const normalizedLabel = compact(label)
  const namedGroup = groupName(group)
  const provider = providerForGroup(snapshot, group)
  const matchesLabel = (model: NativeModel): boolean => {
    const candidates = [model.name, model.id]
    if (isLogfareProvider(provider)) candidates.push(stripLogfarePrefix(model.name), stripLogfarePrefix(model.id))
    return candidates.some(candidate => compact(candidate) === normalizedLabel)
  }
  const inNamedGroup = snapshot.groups.find(candidate => compact(candidate.name) === namedGroup)?.models
    .filter(matchesLabel) ?? []
  if (inNamedGroup.length === 1) return inNamedGroup[0]
  const matches = snapshot.groups.flatMap(candidate => candidate.models)
    .filter(matchesLabel)
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * Split a gateway row whose name carries its billing group.
 *
 * The gateway serves one row per (model, group) and the Host composes the label
 * as `<model> · <group>` so two rows for one model stay distinguishable. That
 * reads as one very long line in the picker, which then ellipsizes exactly the
 * part that says which group the row bills through. Only the plugin's own
 * gateway provider composes names this way, so the split is scoped to it and
 * every other provider keeps its label verbatim.
 */
export function splitGatewayGroupLabel(provider: string | undefined, label: string): { readonly name: string; readonly group: string } | undefined {
  if (provider !== 'freecodego') return undefined
  const index = label.lastIndexOf(' · ')
  if (index <= 0) return undefined
  const name = label.slice(0, index).trim()
  const group = label.slice(index + 3).trim()
  return name === '' || group === '' ? undefined : { name, group }
}

function decorateVisibleModelLabel(row: HTMLButtonElement, provider: string | undefined, model: NativeModel, fallback: string): void {
  const label = visibleModelLabel(provider, model, fallback)
  const split = splitGatewayGroupLabel(provider, label)
  let target = row.querySelector<HTMLElement>('[data-fcg-model-visible-label]')
  if (target === null) {
    const copy = row.querySelector<HTMLElement>('[class*="optionCopy"]') ?? row
    target = copy.querySelector<HTMLElement>('[class*="modelName"], [class*="optionName"]')
    if (target === null) {
      const textNode = [...copy.childNodes].find(node => node.nodeType === Node.TEXT_NODE && compact(node.textContent ?? '') !== '')
      // Only claim the node when React is not tracking it as part of a
      // committed fiber subtree is unknowable here, so never replace or move
      // React-owned text nodes: reuse the existing element when present and
      // otherwise append our own span, leaving the original text untouched.
      // Replacing a React-managed node caused `removeChild` crashes when the
      // menu re-rendered.
      target = document.createElement('span')
      target.dataset.fcgModelVisibleLabel = 'true'
      if (textNode !== undefined) {
        textNode.after(target)
        if (textNode.textContent !== '') (textNode as Text).textContent = ''
      } else {
        copy.prepend(target)
      }
    } else {
      target.dataset.fcgModelVisibleLabel = 'true'
    }
  }
  const labelText = split?.name ?? label
  if (target.textContent !== labelText) target.textContent = labelText
  // The group owns its own line so the model name keeps the width it needs and
  // the group stays readable instead of being the ellipsized tail.
  let group = row.querySelector<HTMLElement>('[data-fcg-model-group]')
  if (split === undefined) {
    if (group !== null) group.remove()
    return
  }
  if (group === null) {
    group = document.createElement('span')
    group.dataset.fcgModelGroup = 'true'
    target.after(group)
  }
  if (group.textContent !== split.group) group.textContent = split.group
}

/** Freeze the picker at its collapsed width.
 *
 * The stock menu sizes itself from its content, so expanding one provider
 * widened the whole menu — a layout jump on every toggle. Every provider
 * heading is visible while collapsed, so the collapsed width already fits
 * them all; model rows never need to widen the menu. Measure that width per
 * menu element with every row hidden (so an expanded provider cannot skew
 * the reading) and pin it; names that no longer fit ellipsize under their
 * tooltip. Menus without provider toggles are not the model picker and stay
 * untouched.
 */
function pinMenuWidth(menu: HTMLElement, pins: MenuWidthPins): void {
  if (menu.querySelector('[data-fcg-provider-toggle]') === null) return
  const signature = [...menu.querySelectorAll<HTMLElement>('[data-fcg-provider-toggle]')]
    .map(heading => compact(heading.textContent ?? ''))
    .join('\u0000')
  const pinned = pins.get(menu)
  if (pinned !== undefined) {
    if (pinned.signature === signature) {
      applyMenuWidth(menu, pinned.width)
      return
    }
    pins.delete(menu)
  }
  const rows = [...menu.querySelectorAll<HTMLElement>('section[role="group"] button[role="menuitemradio"]')]
  const inlineDisplays = rows.map(row => row.style.display)
  for (const row of rows) row.style.display = 'none'
  const width = Math.ceil(menu.getBoundingClientRect().width)
  for (const [index, row] of rows.entries()) row.style.display = inlineDisplays[index] ?? ''
  if (!(width > 0)) return
  pins.set(menu, { width, signature })
  applyMenuWidth(menu, width)
}

function applyMenuWidth(menu: HTMLElement, width: number): void {
  const target = `${width}px`
  if (menu.style.width !== target) menu.style.width = target
  if (menu.dataset.fcgWidthPinned !== 'true') menu.dataset.fcgWidthPinned = 'true'
}

function modelMenuSections(menu: Element): HTMLElement[] {
  return [...menu.querySelectorAll<HTMLElement>('section[role="group"]')]
    .filter(section => section.closest('[role="menu"]') === menu)
}

/** Rank one picker group: the FreeCodeGo gateway is always the first visual
 * section, built-in direct providers follow in DOM order, and user-configured
 * third-party providers sink below every built-in. Unknown (unresolvable)
 * groups keep their DOM position. */
function groupRank(snapshot: NativeModelDirectorySnapshot, section: HTMLElement): number {
  const provider = providerForGroup(snapshot, section)
  if (provider === undefined) return Number.MAX_SAFE_INTEGER - 1
  if (provider === 'freecodego') return 0
  if (isUserProvider(provider)) return Number.MAX_SAFE_INTEGER
  return 1
}

/** Reorder the menu's group sections: FreeCodeGo first, user providers last.
 *
 * The picker renders groups in adapter registration order, so a
 * user-configured provider that registered early sat above FreeCodeGo in the
 * menu. The decorator owns presentation only, so ordering is expressed as DOM
 * order and re-applied per decoration. A signature over child order guards
 * against fighting React: if React re-renders a different order it wins, and
 * our stable order is re-imposed once per change instead of per mutation.
 */
function reorderMenuGroups(
  menu: HTMLElement,
  snapshot: NativeModelDirectorySnapshot,
  groupOrder: GroupOrderState,
): void {
  const sections = modelMenuSections(menu)
  if (sections.length < 2) return
  const parent = sections[0]!.parentElement
  if (parent === null) return
  const signature = sections.map(section => section.getAttribute('aria-labelledby') ?? '').join('\u0000')
  const prior = groupOrder.get(menu)
  if (prior !== undefined && prior.signature === signature) return
  const sorted = [...sections].sort((left, right) => groupRank(snapshot, left) - groupRank(snapshot, right))
  if (sorted.every((section, index) => section === sections[index])) {
    groupOrder.set(menu, { signature })
    return
  }
  for (const section of sorted) parent.append(section)
  // Record the post-append child order: the pre-append `sections` snapshot is
  // stale the moment React re-renders, and a wrong signature makes every later
  // pass believe our order still holds while the DOM shows something else.
  groupOrder.set(menu, { signature: sorted.map(section => section.getAttribute('aria-labelledby') ?? '').join('\u0000') })
}

function syncModelMenuGroups(
  menu: HTMLElement,
  snapshot: NativeModelDirectorySnapshot,
  collapsedGroups: CollapseState,
  language: MenuLanguage,
  availability?: () => ReadonlyMap<string, ModelAvailability>,
): void {
  const sections = modelMenuSections(menu)
  for (const group of sections) {
    const provider = providerForGroup(snapshot, group)
    if (provider === undefined) continue
    const headingId = group.getAttribute('aria-labelledby')
    const heading = headingId === null ? null : document.getElementById(headingId)
    if (!(heading instanceof HTMLElement)) continue
    const rows = [...group.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"][title]')]
    if (rows.length === 0) continue
    // A provider whose every route is unconfigured (key missing, not signed
    // in) reads as inert: grey the heading with the rows. Expandability is
    // deliberately untouched — the user can still see what is behind it.
    const groupModels = snapshot.groups.find(candidate => candidate.id === provider)?.models ?? []
    const allUnavailable = groupModels.length > 0 && availability !== undefined
      && groupModels.every(model => availability().get(`${provider}\u0000${model.id}`)?.available === false)
    const accent = allUnavailable ? 'var(--fcg-text-tertiary, #9ca3af)' : providerAccent(provider)
    heading.dataset.fcgProviderUnavailable = String(allUnavailable)
    if (heading.style.getPropertyValue('--fcg-provider-accent') !== accent) heading.style.setProperty('--fcg-provider-accent', accent)
    let dot = heading.querySelector<HTMLElement>('[data-fcg-provider-dot]')
    if (dot === null) {
      dot = document.createElement('span')
      dot.dataset.fcgProviderDot = 'true'
      dot.setAttribute('aria-hidden', 'true')
      heading.prepend(dot)
    }
    // Every group is a first-class section now that the confidential relay is
    // gone: there is no second provider left to file under the gateway, so the
    // heading is always a real collapse toggle.
    const collapsed = collapsedGroups.get(provider) ?? true
    group.dataset.fcgProviderCollapsed = String(collapsed)
    heading.hidden = false
    heading.dataset.fcgProviderToggle = provider
    if (heading.getAttribute('role') !== 'button') heading.setAttribute('role', 'button')
    if (heading.tabIndex !== 0) heading.tabIndex = 0
    if (heading.getAttribute('aria-expanded') !== String(!collapsed)) heading.setAttribute('aria-expanded', String(!collapsed))
    const headingTitle = collapsed
      ? language === 'zh' ? '展开此提供商模型' : 'Expand provider models'
      : language === 'zh' ? '收起此提供商模型' : 'Collapse provider models'
    if (heading.title !== headingTitle) heading.title = headingTitle
    heading.dataset.fcgModelGroupName ??= compact(heading.textContent ?? '')
    heading.querySelector('[data-fcg-provider-count]')?.remove()
    let chevron = heading.querySelector<HTMLElement>('[data-fcg-provider-chevron]')
    if (chevron === null) {
      chevron = document.createElement('span')
      chevron.dataset.fcgProviderChevron = 'true'
      chevron.setAttribute('aria-hidden', 'true')
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 14 14')
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', 'M4 2.5 8.5 7 4 11.5')
      path.setAttribute('fill', 'none')
      path.setAttribute('stroke', 'currentColor')
      path.setAttribute('stroke-linecap', 'round')
      path.setAttribute('stroke-linejoin', 'round')
      path.setAttribute('stroke-width', '1.5')
      svg.append(path)
      chevron.append(svg)
      heading.append(chevron)
    }
    chevron.dataset.open = String(!collapsed)
  }
}

function decorateModelTrigger(snapshot: NativeModelDirectorySnapshot): void {
  const triggers = document.querySelectorAll<HTMLButtonElement>('[data-composer-card] button[aria-haspopup="menu"]')
  const clear = (): void => { for (const trigger of triggers) trigger.querySelector('[data-fcg-model-trigger-badge]')?.remove() }
  const current = snapshot.current
  if (current === undefined || current === null) { clear(); return }
  const model = snapshot.groups.find(group => group.id === current.provider)?.models.find(item => item.id === current.model)
  if (model === undefined) { clear(); return }
  const presentation = presentationOf(model)
  // Only the multiplier reaches the composer trigger. A "free" tag says nothing
  // the user can act on — they already chose this route — and a health reading
  // changes by the minute, so neither belongs beside the input. A multiplier
  // does convey something decision-relevant: how much this route costs.
  const label = presentation?.multiplier
  if (label === undefined) { clear(); return }
  for (const trigger of triggers) {
    if (trigger.closest('[role="menu"]') !== null) continue
    let badge = trigger.querySelector<HTMLElement>('[data-fcg-model-trigger-badge]')
    if (badge === null) {
      badge = document.createElement('span')
      badge.dataset.fcgModelTriggerBadge = 'true'
      trigger.prepend(badge)
    }
    if (badge.dataset.kind !== 'multiplier' || badge.textContent !== label) {
      badge.dataset.kind = 'multiplier'
      badge.textContent = label
    }
  }
}

function installStyle(): void {
  if (document.head.querySelector('[data-fcg-native-model-badge-style]') !== null) return
  const style = document.createElement('style')
  style.dataset.fcgNativeModelBadgeStyle = 'true'
  style.textContent = `
    [data-fcg-model-menu-badges] { display: inline-flex; flex-wrap: wrap; gap: 4px; margin-left: 8px; pointer-events: none; vertical-align: middle; }
    [data-fcg-model-menu-badge] { display: inline-flex; align-items: center; min-height: 16px; padding: 0 5px; border-radius: 5px; font: 600 10px/16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: .02em; white-space: nowrap; }
    [data-fcg-model-menu-badge="free"] { color: var(--fcg-success); background: var(--fcg-success-subtle); font-weight: 700; letter-spacing: .04em; }
    [data-fcg-model-menu-badge="training"] { color: var(--fcg-warn-label); background: var(--fcg-warn-subtle); }
    [data-fcg-model-menu-badge="multiplier"] { color: var(--dsw-alias-state-business-primary); background: var(--fcg-brand-subtle); }
    [data-fcg-model-menu-badge="healthy"] { color: var(--fcg-success); background: var(--fcg-success-subtle); }
    [data-fcg-model-menu-badge="degraded"] { color: var(--fcg-danger); background: var(--fcg-danger-subtle); }
    [data-fcg-model-menu-badge="unknown"] { color: var(--fcg-warn-label); background: var(--fcg-warn-subtle); }
    [data-fcg-model-menu-badge="unavailable"] { color: var(--fcg-text-tertiary); background: var(--fcg-bg-tip); }
    [data-fcg-model-trigger-badge] { display: inline-flex; align-items: center; flex: 0 0 auto; min-height: 16px; margin-right: 6px; padding: 0 5px; border-radius: 5px; font: 600 10px/16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    [data-fcg-model-trigger-badge][data-kind="free"] { color: var(--fcg-success); background: var(--fcg-success-subtle); }
    [data-fcg-model-trigger-badge][data-kind="multiplier"] { color: var(--dsw-alias-state-business-primary); background: var(--fcg-brand-subtle); }
    [data-fcg-model-menu-badge="healthy"]::before, [data-fcg-model-menu-badge="degraded"]::before, [data-fcg-model-menu-badge="unknown"]::before { content: ''; width: 6px; height: 6px; margin-right: 4px; border-radius: 50%; background: currentColor; }
    [data-fcg-provider-toggle] { display: flex; align-items: center; justify-content: space-between; width: 100%; min-width: 0; min-height: 30px; color: var(--fcg-provider-accent, var(--dsw-alias-label-primary, #111)); font-weight: 600; cursor: pointer; user-select: none; }
    [data-fcg-provider-toggle]:hover, [data-fcg-provider-toggle]:focus-visible { color: var(--fcg-provider-accent, var(--dsw-alias-label-primary, #111)); background: var(--dsw-alias-interactive-bg-hover); outline: none; }
    [data-fcg-provider-toggle][data-fcg-provider-unavailable="true"] { opacity: .62; }
    [data-fcg-provider-toggle][data-fcg-provider-unavailable="true"] [data-fcg-provider-chevron] { opacity: .8; }
    [data-fcg-provider-dot] { display: inline-block; flex: 0 0 7px; width: 7px; height: 7px; margin-right: 7px; border-radius: 50%; background: var(--fcg-provider-accent, var(--dsw-alias-label-primary, #111)); }
    [data-fcg-provider-toggle][data-fcg-provider-unavailable="true"] [data-fcg-provider-dot] { background: var(--fcg-text-tertiary, #9ca3af); }
    [data-fcg-provider-chevron] { display: inline-grid; place-items: center; flex: 0 0 16px; margin-left: auto; margin-right: 12px; color: currentColor; }
    [data-fcg-provider-chevron] svg { width: 14px; height: 14px; transition: transform 120ms ease; }
    [data-fcg-provider-chevron][data-open="true"] svg { transform: rotate(90deg); }
    [data-fcg-provider-count] { display: none; }
    section[data-fcg-provider-collapsed="true"] button[role="menuitemradio"] { display: none !important; }
    button[data-fcg-model-hidden="true"] { display: none !important; }
    [role="menu"] [class*="groups"] { scrollbar-width: thin; scrollbar-color: var(--dsw-alias-scrollbar-bg-l2, #c4c8cf) transparent; }
    [role="menu"] [class*="groups"]::-webkit-scrollbar { width: 6px; height: 6px; }
    [role="menu"] [class*="groups"]::-webkit-scrollbar-thumb { border-radius: 999px; background: var(--dsw-alias-scrollbar-bg-l2, #c4c8cf); }
    [role="menu"] [class*="groups"]::-webkit-scrollbar-track { background: transparent; }
    button[data-fcg-model-unavailable="true"] { cursor: not-allowed !important; filter: grayscale(.72); opacity: .48; }
    [role="menu"][data-fcg-width-pinned="true"] button[role="menuitemradio"] [class*="optionCopy"] { min-width: 0; overflow: hidden; }
    /* The gateway row's billing group gets its own line under the model name:
       on one line it was the ellipsized tail, so the row never said which group
       it bills through. */
    button[role="menuitemradio"] [class*="optionCopy"]:has([data-fcg-model-group]) { display: flex; flex-direction: column; align-items: flex-start; }
    [data-fcg-model-group] { display: block; max-width: 100%; margin-top: 1px; overflow: hidden; color: var(--dsw-alias-label-secondary, var(--fcg-text-tertiary)); font: 400 11px/15px var(--fcg-font-mono, ui-monospace), ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
    [role="menu"][data-fcg-width-pinned="true"] button[role="menuitemradio"] [data-fcg-model-visible-label] { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    [role="menu"][data-fcg-width-pinned="true"] [class*="groups"] { overflow-x: hidden; }
  `
  document.head.append(style)
}

function decorate(options: NativeModelMenuBadgesOptions, collapsedGroups: CollapseState, menuWidthPins: MenuWidthPins, groupOrder: GroupOrderState): void {
  const snapshot = options.snapshot()
  if (snapshot === undefined) return
  decorateModelTrigger(snapshot)
  for (const menu of document.querySelectorAll<HTMLElement>('[role="menu"]')) {
    reorderMenuGroups(menu, snapshot, groupOrder)
    syncModelMenuGroups(menu, snapshot, collapsedGroups, options.language(), options.availability)
    pinMenuWidth(menu, menuWidthPins)
    for (const row of menu.querySelectorAll<HTMLButtonElement>('section[role="group"] button[role="menuitemradio"][title]')) {
      const group = row.closest('section[role="group"]')
      if (group === null) continue
      const originalTitle = row.dataset.fcgModelOriginalTitle ?? row.title
      if (row.dataset.fcgModelOriginalTitle === undefined) row.dataset.fcgModelOriginalTitle = originalTitle
      const model = modelForRow(snapshot, group, originalTitle)
      if (model === undefined) continue
      const presentation = presentationOf(model)
      const provider = providerForGroup(snapshot, group)
      const hidden = isHiddenLogfareTextModel(provider, model)
      if (hidden) {
        row.dataset.fcgModelHidden = 'true'
        continue
      }
      if (row.dataset.fcgModelHidden === 'true') delete row.dataset.fcgModelHidden
      decorateVisibleModelLabel(row, provider, model, originalTitle)
      const availability = provider === undefined ? undefined : options.availability?.().get(`${provider}\u0000${model.id}`)
      const unavailable = availability?.available === false
      // Walk a row back the moment its reason is gone: the early exits below
      // skip rows with nothing left to decorate, and a row left disabled by a
      // stale decision would be unselectable until the whole menu reloads.
      if (!unavailable && row.dataset.fcgModelUnavailable === 'true') {
        restoreGate(row)
        row.title = originalTitle
      }
      // A user-configured third-party provider's billing is unknown to us, so
      // its native FREE/multiplier lane is removed rather than echoed. Rows
      // whose access we cannot resolve keep their native lane (undefined
      // presentation means the official picker renders nothing anyway).
      if (presentation === undefined && !unavailable && !isUserProvider(provider)) continue
      if (isUserProvider(provider)) {
        const nativeMeta = row.querySelector(UPSTREAM_PICKER_CLASS.meta)
        if (nativeMeta !== null && nativeMeta.childElementCount > 0) nativeMeta.replaceChildren()
      }
      if (presentation === undefined && !unavailable) continue
      const language = options.language()
      const values = labels(language, availability)

      // A spent free budget is advisory, not a gate. The park lifts on the
      // upstream's own schedule, while this availability snapshot is taken when
      // the catalog loads: a hard `disabled` from it would outlive the park and
      // leave a usable model unselectable. The badge and the tooltip still say
      // what happened, and the provider answers with the real recovery time.
      const gate = availability?.reason !== 'CLINE_MODEL_RATE_LIMITED'
      if (unavailable) {
        const message = unavailableMessage(availability?.reason, language)
        if (row.dataset.fcgModelOriginalDisabled === undefined) row.dataset.fcgModelOriginalDisabled = String(row.disabled)
        row.dataset.fcgModelUnavailable = 'true'
        row.dataset.fcgModelUnavailableReason = message
        row.title = message
        if (gate) {
          row.disabled = true
          row.setAttribute('aria-disabled', 'true')
        } else {
          // A decision that changed between snapshots must be walked back, or a
          // row gated by a missing credential would stay disabled once the
          // credential arrives and only the budget is out.
          row.disabled = row.dataset.fcgModelOriginalDisabled === 'true'
          row.removeAttribute('aria-disabled')
        }
      }
      if (values.length === 0) continue

      let container = row.querySelector<HTMLElement>('[data-fcg-model-menu-badges]')
      if (container === null) {
        container = document.createElement('span')
        container.dataset.fcgModelMenuBadges = 'true'
        container.setAttribute('aria-hidden', 'true')
        // Keep pricing/access metadata in the row's trailing lane. Appending to
        // optionCopy made the badge a second line under the model name, while
        // the native picker has enough horizontal space for a clean right edge.
        row.append(container)
      }
      const signature = values.map(value => `${value.kind}:${value.label}`).join('|')
      if (container.dataset.fcgSignature === signature) continue
      container.dataset.fcgSignature = signature
      container.replaceChildren(...values.map((value) => {
        const badge = document.createElement('span')
        badge.dataset.fcgModelMenuBadge = value.kind
        badge.textContent = value.label
        return badge
      }))
    }
  }
}

/**
 * Add metadata to the native model menu without replacing its React component.
 * A missing or changed native menu is deliberately a no-op: it must never
 * prevent the Harness picker from opening or selecting a model.
 */
export function installNativeModelMenuBadges(options: NativeModelMenuBadgesOptions): () => void {
  installStyle()
  const collapsedGroups: CollapseState = new Map()
  const menuWidthPins: MenuWidthPins = new WeakMap()
  const groupOrder: GroupOrderState = new WeakMap()
  const boundMenus = new Set<HTMLElement>()
  const toggleGroup = (event: Event): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    const heading = target.closest<HTMLElement>('[data-fcg-provider-toggle]')
    if (heading === null) return
    const menu = heading.closest<HTMLElement>('[role="menu"]')
    const group = heading.closest<HTMLElement>('section[role="group"]')
    if (menu === null || group === null) return
    if (event.type === 'keydown') {
      const keyboard = event as KeyboardEvent
      if (keyboard.key !== 'Enter' && keyboard.key !== ' ') return
    }
    event.preventDefault()
    event.stopPropagation()
    const provider = heading.dataset.fcgProviderToggle
    if (provider === undefined) return
    const collapsed = collapsedGroups.get(provider) ?? group.dataset.fcgProviderCollapsed === 'true'
    collapsedGroups.set(provider, !collapsed)
    const snapshot = options.snapshot()
    if (snapshot !== undefined) syncModelMenuGroups(menu, snapshot, collapsedGroups, options.language(), options.availability)
    refresh()
  }
  let frame: number | undefined
  const refresh = (): void => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      frame = undefined
      bindMenus()
      decorate(options, collapsedGroups, menuWidthPins, groupOrder)
    })
  }
  const bindMenus = (): void => {
    for (const menu of document.querySelectorAll<HTMLElement>('[role="menu"]')) {
      if (boundMenus.has(menu)) continue
      menu.addEventListener('click', toggleGroup)
      menu.addEventListener('keydown', toggleGroup)
      boundMenus.add(menu)
    }
  }
  const observer = new MutationObserver(refresh)
  observer.observe(document.body, { childList: true, subtree: true })
  bindMenus()
  document.addEventListener('fcg:model-availability-updated', refresh)
  refresh()
  return () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    observer.disconnect()
    for (const menu of boundMenus) {
      menu.removeEventListener('click', toggleGroup)
      menu.removeEventListener('keydown', toggleGroup)
    }
    boundMenus.clear()
    document.removeEventListener('fcg:model-availability-updated', refresh)
  }
}
