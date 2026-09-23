/**
 * Which providers and models the chat model picker is allowed to show.
 *
 * The Accounts-and-providers page is where a user decides what they want in the
 * picker, but the picker itself is the stock Harness menu: the Host still
 * registers every adapter and every model, and this store is what the picker
 * decorator consults before it renders a provider section or a model row.
 *
 * Storage is *negative* — a provider or model is shown unless it is explicitly
 * recorded as hidden — with two declared exceptions. A metered provider (see
 * {@link METERED_DEFAULT_HIDDEN_PROVIDERS}) defaults its priced rows to hidden,
 * and a curated provider (see {@link DEFAULT_VISIBLE_MODELS}) defaults its
 * unnamed rows to hidden; either way only the decisions that disagree with the
 * default are stored. Three consequences are worth stating, because they are the
 * reason for the shape:
 *
 * - The default is the picker's current contents, so nothing changes for a user
 *   who never opens the controls, and a model that a provider adds later arrives
 *   visible — unless it is priced, which is the one thing that should not arrive
 *   switched on by itself.
 * - The price is asked per row ({@link ModelPriceClass}) rather than per
 *   provider, because a metered provider's roster usually holds both: a free
 *   tier and the routes that cost money.
 * - Un-hiding is deleting a key, so a preference can never drift into "hidden
 *   for a reason nobody can reproduce".
 *
 * The preference is per browser profile (`localStorage`), like the remembered
 * sign-in fields beside it: it describes what this user wants to see in this
 * client, not what the Host is able to route. The document itself — reading,
 * writing, and the change event — is {@link ./model-picker-visibility-store};
 * this module is the policy over it, and re-exports its API so every consumer
 * keeps naming one module.
 *
 * @module client/model-picker-visibility
 */

import type { ModelPriceClass } from './model-price.ts'
import { omitKey, type ModelPickerVisibility } from './model-picker-visibility-store.ts'

export {
  EMPTY_MODEL_PICKER_VISIBILITY,
  MODEL_VISIBILITY_EVENT,
  clearModelPickerVisibility,
  normalizeModelPickerVisibility,
  readModelPickerVisibility,
  subscribeModelPickerVisibility,
  writeModelPickerVisibility,
  type ModelPickerVisibility,
} from './model-picker-visibility-store.ts'

/**
 * Providers whose models the cards know are free to use.
 *
 * Only providers whose *whole* directory ships on a free tier belong here:
 * Cline and WorkBuddy hand out per-account free routes, and SenseNova, NVIDIA,
 * OpenCode, Kiló and B.AI are free endpoints. logfare is deliberately absent —
 * its directory is split into a free standard tier and a premium tier that
 * needs a training-data consent, so tagging every row there as free would
 * advertise premium routes at no cost. A metered provider (VyceAI, Agnes) is
 * absent for the same reason: the picker lists its rows because the user has an
 * account there, which says nothing about price.
 */
export const FREE_TIER_PROVIDERS: ReadonlySet<string> = new Set(['opencode', 'kilo', 'cline', 'workbuddy', 'sensenova', 'nvidia', 'bai'])

/**
 * Providers whose picker rows start hidden unless the model is named here.
 *
 * The store is otherwise negative — absent means shown — which is right for a
 * provider whose roster the plugin does not curate. VyceAI is the exception:
 * every one of its routes is metered, so listing its whole directory in the
 * chat menu by default would offer a dozen ways to spend money the moment a key
 * is saved. Only the three routes that are the default offer start switched on;
 * the rest are one click away, and an explicit choice is stored as the opposite
 * of the default (see {@link isModelVisible}).
 *
 * Ids are the bare wire ids, so both the `vyce/deepseek-v4.1` the picker spells
 * and a bare `deepseek-v4.1` match.
 *
 * A name outranks a price here. `deepseek-v4.1` publishes per-million prices, so
 * the row's own description reads as `paid` — and it is still one of the
 * defaults, because the whole point of the provider is that the daily check-in
 * credit pays for exactly these routes; dropping it would hide the offer the
 * provider was configured for. A priced route that is *not* named is unaffected
 * and still starts off (see {@link METERED_DEFAULT_HIDDEN_PROVIDERS}).
 */
export const DEFAULT_VISIBLE_MODELS: Readonly<Record<string, readonly string[]>> = {
  vyce: ['deepseek-v4.1', 'qwen3.8-flash', 'claude-sonnet-4-6'],
}

/**
 * Providers whose priced rows start hidden unless the user asks for them.
 *
 * These are the providers whose rosters the plugin does not curate but does
 * *price*: Cline's and WorkBuddy's free budgets, Qoder's metered routes, the
 * metered providers beside them. A route the directory prices above zero is
 * money the user did not ask to spend, so it waits behind one click instead of
 * appearing in the composer the moment its provider is configured — which is
 * the whole point of asking for a price in the first place.
 *
 * `freecodego` is deliberately absent: the gateway's directory is the account's
 * own plan, the page that shows it is the billing surface, and a second place to
 * switch its models on would be a second answer to "what may this account
 * spend". A provider whose rows the directory does not price is unaffected too —
 * {@link modelDefaultVisible} only reads a `paid` verdict.
 */
export const METERED_DEFAULT_HIDDEN_PROVIDERS: ReadonlySet<string> = new Set(['cline', 'workbuddy', 'vyce', 'qoder', 'agnes'])

/** {@link DEFAULT_VISIBLE_MODELS} as lookup sets, lowercased once. */
const DEFAULT_VISIBLE_SETS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(DEFAULT_VISIBLE_MODELS).map(([provider, ids]) => [provider, new Set(ids.map(id => id.toLowerCase()))]),
)

/**
 * Drop a gateway group pin so one decision covers every group of a model.
 *
 * The gateway lists one row per (model, group) and the picker shows each as its
 * own row under the same name. Hiding "the model" has to mean all of them, or
 * the user unchecks one row and the model stays in the menu under another
 * group. The rule mirrors the Host's `parseGroupPin` (`model-catalog.ts`); the
 * browser cannot import the Host bundle, so the regex is restated here — the
 * same way `settings-tab.tsx` states it for display.
 * @param modelId - the picker's model id.
 * @returns the model id without its `@group:N` suffix.
 */
export function bareModelId(modelId: string): string {
  return /^(.*?)(?:@group:\d+)$/u.exec(modelId.trim())?.[1] ?? modelId.trim()
}

/**
 * The key one model's visibility decision is stored under.
 * @param provider - provider id the row belongs to.
 * @param modelId - the picker's model id, pinned or not.
 * @returns the storage key.
 */
export function modelVisibilityKey(provider: string, modelId: string): string {
  return `${provider.trim().toLowerCase()}\u0000${bareModelId(modelId)}`
}

/**
 * Whether a provider's section is shown.
 * @param visibility - the current decisions.
 * @param provider - provider id from the picker directory.
 * @returns whether the provider may be rendered.
 */
export function isProviderVisible(visibility: ModelPickerVisibility, provider: string | undefined): boolean {
  if (provider === undefined) return true
  return visibility.providers[provider.trim().toLowerCase()] !== false
}

/**
 * Whether a provider's rows start shown.
 *
 * A curated provider (see {@link DEFAULT_VISIBLE_MODELS}) is decided by its own
 * list and nothing else: naming a route is the plugin's statement about which
 * routes this provider is configured for, and it is a sharper answer than the
 * price is — which is why a named route stays on even when the directory prices
 * it. Every other provider follows the price rule: a priced row of a metered
 * provider starts hidden, the rest start shown.
 *
 * An `unknown` price is not read as `paid`: a route the directory does not price
 * is still an answer to "may this be in my list" that the user already gave by
 * configuring that provider, and hiding it would make the new rule swallow
 * rosters it was never about.
 * @param provider - provider id from the picker directory.
 * @param modelId - the picker's model id, pinned or not.
 * @param price - what the row's own description says it costs.
 * @returns the default for this provider and model.
 */
export function modelDefaultVisible(provider: string, modelId: string, price: ModelPriceClass = 'unknown'): boolean {
  const key = provider.trim().toLowerCase()
  const set = DEFAULT_VISIBLE_SETS.get(key)
  if (set === undefined) return !(price === 'paid' && METERED_DEFAULT_HIDDEN_PROVIDERS.has(key))
  const bare = bareModelId(modelId)
  const prefix = `${key}/`
  const slug = (bare.toLowerCase().startsWith(prefix) ? bare.slice(prefix.length) : bare).toLowerCase()
  return set.has(slug)
}

/**
 * Whether one model row is shown.
 *
 * A model whose provider is hidden is hidden too, whatever its own entry says:
 * the section is not rendered, so leaving the per-model flag alone keeps the
 * user's row selection intact for the moment they switch the provider back on.
 *
 * With no stored entry the declared default decides — see
 * {@link modelDefaultVisible} for the three cases it covers.
 * @param visibility - the current decisions.
 * @param provider - provider id the row belongs to.
 * @param modelId - the picker's model id, pinned or not.
 * @param price - what the row's own description says it costs.
 * @returns whether the row may be rendered.
 */
export function isModelVisible(visibility: ModelPickerVisibility, provider: string | undefined, modelId: string, price: ModelPriceClass = 'unknown'): boolean {
  if (provider === undefined) return true
  if (!isProviderVisible(visibility, provider)) return false
  const entry = visibility.models[modelVisibilityKey(provider, modelId)]
  return entry ?? modelDefaultVisible(provider, modelId, price)
}

/**
 * Hide or show one provider.
 * @param visibility - the current decisions.
 * @param provider - provider id from the picker directory.
 * @param visible - whether the section may be rendered.
 * @returns the next decisions.
 */
export function setProviderVisible(visibility: ModelPickerVisibility, provider: string, visible: boolean): ModelPickerVisibility {
  const key = provider.trim().toLowerCase()
  if (key === '') return visibility
  const providers = visible ? omitKey(visibility.providers, key) : { ...visibility.providers, [key]: false }
  return { ...visibility, providers }
}

/**
 * Hide or show one model.
 * @param visibility - the current decisions.
 * @param provider - provider id the row belongs to.
 * @param modelId - the picker's model id, pinned or not.
 * @param visible - whether the row may be rendered.
 * @param price - what the row's own description says it costs.
 * @returns the next decisions.
 */
export function setModelVisible(
  visibility: ModelPickerVisibility,
  provider: string,
  modelId: string,
  visible: boolean,
  price: ModelPriceClass = 'unknown',
): ModelPickerVisibility {
  const key = modelVisibilityKey(provider, modelId)
  if (key.endsWith('\u0000')) return visibility
  // Only the exception is stored: a decision that agrees with the default is
  // dropped, so "reset" remains a matter of forgetting keys rather than
  // replaying a snapshot, and a curated provider can still be switched on.
  // Switching a priced row on is exactly such an exception, so it is kept even
  // though it is `true` — the stored document is a list of disagreements with
  // the price, not a list of refusals.
  const models = visible === modelDefaultVisible(provider, modelId, price)
    ? omitKey(visibility.models, key)
    : { ...visibility.models, [key]: visible }
  return { ...visibility, models }
}

/**
 * Hide or show a whole provider's models at once.
 *
 * The per-model controls are what the panel writes one at a time, but "show all
 * / hide all" is the same decision applied to every row the directory reported,
 * and writing it in one pass keeps the panel from dispatching one event per row.
 * Rows rather than ids: each row's price is half of its default, so a decision
 * made from ids alone would switch a priced route on for a user who pressed
 * "All" to mean "all the ones I was already being offered".
 * @param visibility - the current decisions.
 * @param provider - provider id the rows belong to.
 * @param rows - the rows to apply the decision to, each with what its own `description` says it costs.
 * @param visible - whether those rows may be rendered.
 * @returns the next decisions.
 */
export function setModelsVisible(
  visibility: ModelPickerVisibility,
  provider: string,
  rows: readonly { readonly id: string; readonly price?: ModelPriceClass | undefined }[],
  visible: boolean,
): ModelPickerVisibility {
  const defaults = new Map<string, boolean>()
  for (const row of rows) {
    const key = modelVisibilityKey(provider, row.id)
    if (key.endsWith('\u0000')) continue
    defaults.set(key, modelDefaultVisible(provider, row.id, row.price ?? 'unknown'))
  }
  if (defaults.size === 0) return visibility
  // One rebuild for the whole roster: a decision is kept only where it differs
  // from that row's default, so "All"/"None" on a curated provider stores the
  // minority either way rather than a refusal for every row.
  const models: Record<string, boolean> = {}
  for (const [entryKey, value] of Object.entries(visibility.models)) {
    if (defaults.has(entryKey)) continue
    models[entryKey] = value
  }
  for (const [key, isDefault] of defaults) {
    if (visible !== isDefault) models[key] = visible
  }
  return { ...visibility, models }
}
