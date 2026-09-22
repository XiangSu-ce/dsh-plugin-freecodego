import { isLockedRoute, isZeroPriceRoute } from '@deepseek-ai/dsh-freecodego-api'
import type { FreeCodeGoCatalog, FreeCodeGoModelOptionGroup, FreeCodeGoModelRouteOption } from '@deepseek-ai/dsh-freecodego-api'
import type { FreeCodeGoManagedCatalog, FreeCodeGoManagedCatalogChoice, FreeCodeGoManagedCatalogGroup } from './types.ts'
import { normalizeWireProtocol, SUPPORTED_WIRE_PROTOCOLS } from './openai-compatible-adapter.ts'

const LOGFARE_MODEL_PREFIX = 'logfare/'

/** Query param that pins a gateway request to one backend group.
 *
 * The picker lists one row per (model, group); selecting a row must reach the
 * exact group it names, not whatever the Host would otherwise route. The suffix travels
 * inside the selection value so the session's persisted model id keeps round-
 * tripping through settings without a second field. Stripping is centralized
 * here because three layers see the id: routing, the wire, and the picker. */
export const GROUP_PIN_PARAM = '@group'

/**
 * Model id plus its group pin: `gpt-5.6@group:4`. Absent pin = Host default.
 * @param modelId - the wire model id.
 * @param groupId - the backend group to pin the selection to.
 * @returns the pinned selection value.
 */
export function withGroupPin(modelId: string, groupId: number): string {
  return `${modelId}${GROUP_PIN_PARAM}:${groupId}`
}

/**
 * Split `id@group:N` into the wire model id and the pinned group.
 * @param selection - the selection value to split.
 * @returns the wire model id and the pinned group, when one is present.
 */
export function parseGroupPin(selection: string): { readonly modelId: string; readonly groupId?: number } {
  const match = new RegExp(`^(.+?)${GROUP_PIN_PARAM}:(\\d+)$`, 'u').exec(selection.trim())
  if (match === null) return { modelId: selection.trim() }
  return { modelId: match[1]!.trim(), groupId: Number(match[2]) }
}

/**
 * Protocols the FreeCodeGo adapter can speak on the wire.
 *
 * `OpenAiCompatibleAdapter` sends an OpenAI chat-completions body to
 * `/chat/completions` for the OpenAI dialects and an Anthropic Messages body
 * to `/messages` for `anthropic`; anything else has no wire, so a pinned row
 * for such a group must not be offered as selectable. Both facts come from the
 * transport itself — `SUPPORTED_WIRE_PROTOCOLS` for the set and
 * `normalizeWireProtocol` for the spelling rule — so this layer cannot offer a
 * row the router would refuse, or hide one it could send. The list was once
 * restated here, and a fourth wire would have been added to one of the two
 * copies only.
 */
export const SUPPORTED_WIRE_PROTOCOL_SET: ReadonlySet<string> = new Set(SUPPORTED_WIRE_PROTOCOLS)

/**
 * A group row is offerable when the account can use it and we can send it.
 * @param choice - the group row's enablement, lock state, and protocol.
 * @returns whether the row can be offered as selectable.
 */
export function isGroupRowSelectable(choice: {
  readonly enabled?: boolean
  readonly locked?: boolean
  readonly protocol?: string
}): boolean {
  if (choice.enabled === false || choice.locked === true) return false
  // Folded by the transport's own rule rather than a copy of it: a spelling this
  // predicate accepts while the router rejects it offers a row that fails on
  // selection, and the reverse hides a group the account can actually use.
  const protocol = normalizeWireProtocol(choice.protocol)
  // A route that declares no protocol stays offerable for the same reason
  // routing keeps it usable: legacy options send the OpenAI default, so there is
  // nothing here to compare, not an unknown wire to refuse.
  if (protocol === '') return true
  return SUPPORTED_WIRE_PROTOCOL_SET.has(protocol)
}
const REMOVED_FREE_MODEL_IDS = new Set([
  'deepseek-v4-pro', 'gemini-3-flash', 'kimi-k2.6', 'gemini-3.5-flash',
  'moonshotai/kimi-k2.6', 'mimo/mimo-v2.5', 'mimo/mimo-v2.5-pro',
  'minimax/minimax-m2.7', 'minimax/minimax-m3',
  'google/gemini-2.5-flash-lite', 'google/gemini-3.1-flash-lite-preview',
  'google/gemini-3.1-pro-preview',
])

/** One row per route, in the order the backend listed them.
 *
 * The backend can list the same group route twice: `gpt-5.6-terra` arrived from
 * `/models/options` as two `group:2:gpt-5.6-terra` choices — same group id, same
 * group name, same rate, same protocol, byte-identical. Rendering both put two
 * `gpt 5.6 terra ×0.1` rows in the picker, which reads as a defect in the model
 * list rather than as a choice the user is making.
 *
 * Two choices that share a route key are the same route, so one row is the
 * honest answer. A genuinely different group keeps its own row, because its
 * route key differs — the collapse is keyed on the route, never on the visible
 * text, so two same-named groups at different rates both stay selectable.
 * @param routes - the option routes one model received.
 * @returns the routes with duplicate keys collapsed to the first occurrence.
 */
function distinctRoutes(routes: readonly FreeCodeGoModelRouteOption['options'][number][]): readonly FreeCodeGoModelRouteOption['options'][number][] {
  const seen = new Set<string>()
  return routes.filter((route) => {
    const key = route.routeKey
    if (key === undefined || key === '') return true
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Merge the account's model-option groups into the browser-safe model catalog.
 *
 * The option groups — not the bootstrap projection — are the only rows that
 * carry a group route key, a rate multiplier, and lock state: `/agent/bootstrap`
 * rewrites every route key into the legacy `model:<protocol>:<model>` spelling,
 * drops the group id/name and the multiplier, and de-dupes to one row per
 * protocol. Matching choices by route key therefore never found a group, so the
 * picker showed no group name, no multiplier, and no lock reason.
 *
 * When a model has option groups, the choice list is rebuilt from them; a model
 * with no groups keeps its bootstrap choices untouched.
 * @param models - the bootstrap catalog models to enrich.
 * @param options - the account's model-option groups.
 * @returns the models with their group choices rebuilt.
 */
export function enrichCatalogChoices(models: FreeCodeGoCatalog['models'], options: readonly FreeCodeGoModelRouteOption[]): FreeCodeGoManagedCatalog['models'] {
  return models.map((model) => {
    const routes = distinctRoutes(options.find(option => option.model === model.id || option.model.toLowerCase() === model.id.toLowerCase())?.options ?? [])
    if (routes.length === 0) return model
    const engines = model.choices[0]?.compatibleEngines ?? model.compatibleEngines
    return {
      ...model,
      choices: routes.map((route): FreeCodeGoManagedCatalogChoice => {
        // A row with no explicit `enabled` is treated as enabled, and both lock
        // spellings collapse into one `locked` flag (see `isLockedRoute`).
        const enabled =  route.enabled
        const locked =  route.locked || isLockedRoute(route)
        const zeroPrice = isZeroPriceRoute(route)
        const groupName = (route.groupName ?? '').trim()
        return {
          routeKey: route.routeKey,
          label: groupName === '' ? route.routeKey : groupName,
          availability: enabled && !locked ? 'available' : 'unavailable',
          compatibleEngines: engines,
          ...(route.groupId === undefined ? {} : { groupId: route.groupId }),
          ...(route.groupName === undefined ? {} : { groupName: route.groupName }),
          ...(route.protocol === undefined ? {} : { protocol: route.protocol }),
          ...(route.access === undefined ? {} : { access: route.access }),
          ...(route.unlockRequired === true ? { unlockRequired: true } : {}),
          ...(route.unlockReason === undefined ? {} : { unlockReason: route.unlockReason }),
          ...(route.unlockExpiresAt === undefined ? {} : { unlockExpiresAt: route.unlockExpiresAt }),
          zeroPrice,
          locked,
          ...(zeroPrice ? { rateMultiplier: 0 } : route.rateMultiplier === undefined ? {} : { rateMultiplier: route.rateMultiplier }),
        }
      }),
    }
  })
}

/** One picker row per (model, group) the account can actually use.
 *
 * The user-visible catalog collapses a model's group options into the wire id
 * `id@group:N`; routing reads the pin and serves exactly that group, so the
 * choice the user made in the picker is the one that executes. A model with no
 * group options keeps one unpinned row, and routing then follows the backend's
 * declared default group (see `selectModelOptionChoice`). */
export interface GroupPinnedCatalogModel {
  readonly id: string
  readonly displayName: string
  readonly availability: 'available' | 'unavailable'
  readonly unavailableReason?: string
  readonly inputModalities: readonly ('text' | 'image')[]
}

/** Minimal row shape with the pin metadata this projection attaches. */
export type GroupPinnedModelRow = GroupPinnedCatalogModel & {
  /** Pinned backend group id; absent on the single unpinned fallback row. */
  readonly __groupPin?: number
  /** Backend group name; present exactly when `__groupPin` is. */
  readonly __groupLabel?: string
  /** The group's rate as the backend reported it (`0` = free). */
  readonly __groupRate?: number
  /** Why this group's row cannot be selected; absent = selectable. */
  readonly __groupUnavailable?: string
}

/** Reason code shown when a group exists but the account cannot route through it. */
export const GROUP_LOCKED_REASON = 'FREECODEGO_GROUP_LOCKED'
/** Reason code for a group that is switched off, or has no wire we can send. */
export const GROUP_UNAVAILABLE_REASON = 'FREECODEGO_GROUP_UNAVAILABLE'

/**
 * Why a group option cannot serve, or `undefined` when it can.
 * @param route - the group option's lock, unlock, enablement, and protocol.
 * @returns the reason code, or `undefined` when the group can serve.
 */
export function groupRowBlockReason(route: {
  readonly enabled?: boolean
  readonly locked?: boolean
  readonly unlockRequired?: boolean
  readonly protocol?: string
}): string | undefined {
  if (route.locked === true || route.unlockRequired === true) return GROUP_LOCKED_REASON
  if (route.enabled === false || !isGroupRowSelectable(route)) return GROUP_UNAVAILABLE_REASON
  return undefined
}

/**
 * One picker row per (model, group) the backend publishes.
 *
 * Every group the backend lists becomes a row carrying its own pin, name and
 * rate, so the same model legitimately appears once per group — that duplicate
 * is the information the user selects on. A group the account cannot route
 * through (locked, switched off, or speaking a protocol with no wire) stays
 * visible as an unavailable row carrying the reason, because a group that
 * silently disappears is indistinguishable from one that was never sold.
 * A model the backend grouped nowhere keeps its single unpinned row.
 *
 * A blocked group stays on the row (see `modelRowGroupBlock` for who reports
 * the reason) rather than being dropped here: this projection answers "which
 * groups does the backend publish", and the answer is the same whether or not
 * the account happens to be entitled to one today.
 * @returns the group Pinned Model Row rows, in backend order.
 * @param models - the catalog models to expand.
 * @param options - the account's model-option groups.
 */
export function expandGroupPinnedModels(
  models: readonly GroupPinnedCatalogModel[],
  options: readonly FreeCodeGoModelRouteOption[],
): readonly GroupPinnedModelRow[] {
  const rows: GroupPinnedModelRow[] = []
  const seen = new Set<string>()
  const push = (row: GroupPinnedModelRow): void => {
    if (seen.has(row.id)) return
    seen.add(row.id)
    rows.push(row)
  }
  for (const model of models) {
    const routes = distinctRoutes(options.find(option => option.model === model.id || option.model.toLowerCase() === model.id.toLowerCase())?.options ?? [])
    const printed = routes.filter(route => route.groupId !== undefined)
    if (printed.length === 0) {
      push({ ...model })
      continue
    }
    for (const route of printed) {
      const blocked = groupRowBlockReason(route)
      push({
        ...model,
        id: withGroupPin(model.id, route.groupId),
        __groupPin: route.groupId,
        ...(route.groupName === undefined ? {} : { __groupLabel: route.groupName }),
        ...(route.rateMultiplier === undefined && !route.zeroPrice ? {} : { __groupRate: route.rateMultiplier ?? 0 }),
        ...(blocked === undefined ? {} : { __groupUnavailable: blocked }),
      })
    }
  }
  return rows
}
/** The group-level block to report for one picker row, or `undefined`.
 *
 * A model-level block outranks the group's own state: a signed-out user must
 * fix the account before any group becomes reachable, so letting the group
 * reason win would point at the wrong fix ("unlock this group" on a row that
 * only needs a login). When the model itself is usable, the group's own reason
 * explains the row — a group the account cannot bill through is disabled with
/**
 * hat reason instead of being listed as if it worked.
 * @param row - the pinned picker row to inspect.
 * @returns the group-level block reason, or `undefined` when the row is usable.
 */
export function modelRowGroupBlock(row: GroupPinnedModelRow): string | undefined {
  return row.availability === 'available' ? row.__groupUnavailable : undefined
}

/**
 * Project the account's option groups into the browser-safe catalog groups.
 * @param groups - the account's model-option groups.
 * @returns the catalog group rows.
 */
export function managedCatalogGroups(groups: readonly FreeCodeGoModelOptionGroup[]): readonly FreeCodeGoManagedCatalogGroup[] {
  return groups.map(group => ({
    id: group.id,
    name: group.name,
    enabled: group.enabled,
    // The backend's account-default marker decides which group serves an
    // unpinned selection; dropping it is what forced the Host to guess.
    ...(group.default === true ? { default: true as const } : {}),
    ...(group.description === undefined ? {} : { description: group.description }),
    ...(group.platform === undefined ? {} : { platform: group.platform }),
    ...(group.protocol === undefined ? {} : { protocol: group.protocol }),
    ...(group.rateMultiplier === undefined ? {} : { rateMultiplier: group.rateMultiplier }),
    ...(group.activityLabel === undefined ? {} : { activityLabel: group.activityLabel }),
    ...(group.unlockReason === undefined ? {} : { unlockReason: group.unlockReason }),
    ...(group.unlockExpiresAt === undefined ? {} : { unlockExpiresAt: group.unlockExpiresAt }),
    ...(group.sortOrder === undefined ? {} : { sortOrder: group.sortOrder }),
  }))
}

/**
 * Render a model's per-choice rate multipliers as a display string.
 * @param model - the model whose choices are summarized.
 * @returns the joined multiplier text, or a placeholder when none is known.
 */
export function modelMultiplierDescription(model: { readonly choices: readonly { readonly zeroPrice?: boolean; readonly rateMultiplier?: number }[] }): string {
  const values = model.choices.map(choice => choice.zeroPrice === true ? 0 : choice.rateMultiplier).filter((value): value is number => value !== undefined && Number.isFinite(value))
  return values.length === 0 ? '倍率未知' : Array.from(new Set(values)).map(value => `×${value}`).join(' / ')
}

/** Providers that own their own adapter and must never appear under the
 * FreeCodeGo gateway: the gateway group is a directory of gateway routes, and
 * a row from one of these would offer a route the gateway cannot serve. */
const DIRECT_PROVIDERS: ReadonlySet<string> = new Set(['opencode', 'openrouter', 'agnes', 'logfare', 'sensenova', 'nvidia', 'bai', 'kilo', 'cline', 'workbuddy'])

/** A wire id whose prefix names a direct provider (`agnes/foo`, `bai:foo`). */
const DIRECT_PROVIDER_PREFIX_RE = /^(?:opencode|openrouter|agnes|logfare|sensenova|nvidia|bai|kilo|cline|workbuddy)[/:]/u

/** Remove direct-provider rows from the gateway-owned catalog.
 *
 * The managed catalog is a merged view of several sources, so its rows carry
 * the *owning* provider even though they share one cache file. Only rows the
 * gateway itself serves may reach `listFreeCodeGoModels`; everything else has
 * a dedicated adapter and a dedicated picker group.
 *
 * Agnes was missing from this list, so its media routes were offered under the
 * FreeCodeGo group as if the gateway served them — they are image/video models,
 * so selecting one started a chat request against a route that only accepts a
/**
 * eneration prompt.
 * @param models - the merged catalog rows to filter.
 * @returns the gateway-owned rows only.
 */
export function mergeCatalogModels(models: FreeCodeGoManagedCatalog['models']): FreeCodeGoManagedCatalog['models'] {
  return models.filter((model) => {
    const id = model.id.trim().toLowerCase()
    const source = model.provider.trim().toLowerCase()
    return !REMOVED_FREE_MODEL_IDS.has(id)
      && !id.includes('ox-alpha')
      && !id.startsWith(LOGFARE_MODEL_PREFIX)
      && !DIRECT_PROVIDERS.has(source)
      // A stale snapshot may carry the wire id without the owning provider, so
      // match the id prefix too. `agnes/…` is the same route either way.
      && !DIRECT_PROVIDER_PREFIX_RE.test(id)
  })
}

/**
 * Conservative visual-input detection for catalogs without modality metadata.
 * @param id - the model id.
 * @param name - the model's display name.
 * @returns the input modalities the model is inferred to accept.
 */
export function imageInputModalities(id: string, name: string): readonly ('text' | 'image')[] {
  const value = `${id} ${name}`.toLowerCase()
  if (/(?:dall[-_.]?e|gpt[-_.]?image|imagen|imagegen|flux|sdxl|stable[-_. ]?diffusion|midjourney|ideogram|recraft|(?:image|vision)[-_.]?(?:generation|gen|edit))/iu.test(value)) return ['text']
  return /(?:\bgpt[\s_.-]?(?:4o|4\.1|4\.5|5)\b|\bgemini\b|\bclaude\b|\bgrok\b|(?:[-_.]|\b)(?:vision|vl|4v)(?:[-_.]|\b))/iu.test(value)
    ? ['text', 'image']
    : ['text']
}
