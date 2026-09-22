/**
 * What one picker row's own description says about its price.
 *
 * Two surfaces need the same answer — the menu badge that tags a row, and the
 * per-provider visibility controls that decide whether a row starts shown — and
 * they need it from the same reading, or the menu would badge a route as paid
 * while the controls had already decided it was free. So the reading lives here,
 * once, and both import it.
 *
 * The description is the only price channel the picker has: adapters compose it
 * (`Cline · ×0 · 官方免费模型`, `Kilo · ×0 · free`), the Host is what knows a
 * route's real cost, and a browser half cannot re-derive it from the wire. A row
 * whose description states no price is therefore *unknown*, not free — the
 * distinction is what keeps a route we cannot price from being presented as
 * something the user is not paying for.
 *
 * @module client/model-price
 */

/**
 * Tags that make a row paid whatever else it says.
 *
 * `tag:training` gates a route behind a data-consent the user has to give, so the
 * price is not what stands between them and it. `tag:metered` is how an adapter
 * states that a route costs something it cannot put a number on — Cline's feed
 * separates its free half from its subscription half without stating a rate, and
 * inventing `×1` for those rows would be a price this code guessed rather than
 * read. Absent either tag, the multiplier and the amounts below are the only
 * price signals a description carries.
 */
const PAID_TAGS = ['tag:training', 'tag:metered']

/**
 * Provider names that are free by construction, whatever their rows say.
 *
 * These spell their source name rather than a multiplier, so the only way to
 * read them is by name. It is deliberately short: a name belongs here only when
 * *every* route behind it is free, because the tag it produces is a claim about
 * price. `logfare` and `vyce` are absent for that reason — both are split into
 * free and metered routes, so tagging by name would advertise the metered half
 * at no cost.
 */
const FREE_SOURCES = new Set(['opencode', 'openrouter', 'logfare', 'mystery provider', 'mystery provider 2'])

/** How one row is priced, as far as its description states. */
export type ModelPriceClass = 'free' | 'paid' | 'unknown'

/**
 * Every `×N` / `xN` multiplier the description states.
 *
 * A description can carry more than one (a range, or one per price column), so
 * this returns all of them and the callers decide: the badge lists them, the
 * price class only asks whether any is a zero or any is above it.
 * @param description - the row's description, when it has one.
 * @returns each distinct multiplier, in the order it appears.
 */
export function modelMultipliers(description: string | undefined): readonly number[] {
  if (description === undefined) return []
  return [...description.matchAll(/(?:×|x)\s*(\d+(?:\.\d+)?)/giu)]
    .map(match => Number(match[1]))
    .filter(value => Number.isFinite(value))
}

/**
 * Every currency amount the description states, in whole US dollars.
 *
 * A multiplier is not the only way to price a route: VyceAI publishes per-million
 * token prices instead, and reading only multipliers left every one of its routes
 * unpriced — which the visibility controls then read as "not paid", the one
 * answer those rows must not get. The amounts are read as a *presence*, not as a
 * rate: what matters is whether the route costs something, not how much.
 * @param description - the row's description, when it has one.
 * @returns each stated amount, in the order it appears.
 */
export function modelAmounts(description: string | undefined): readonly number[] {
  if (description === undefined) return []
  return [...description.matchAll(/\$\s*(\d+(?:\.\d+)?)/gu)]
    .map(match => Number(match[1]))
    .filter(value => Number.isFinite(value))
}

/**
 * The source name a description leads with, e.g. `Cline` for
 * `Cline · ×0 · 官方免费模型`.
 * @param description - the row's description, when it has one.
 * @returns the leading segment, trimmed.
 */
export function modelSourceOf(description: string | undefined): string {
  return (description ?? '').split('·', 1)[0]?.replace(/\s+/gu, ' ').trim() ?? ''
}

/**
 * Classify one row's price from the description the Host composed.
 *
 * A training-data premium is paid even when its multiplier reads zero: the
 * consent gate, not the price, is what stands between the user and that route,
 * and calling it free would put it in the free default the user never asked for.
 * @param description - the row's description, when it has one.
 * @returns the price class; `unknown` when the description states no price.
 */
export function modelPriceClass(description: string | undefined): ModelPriceClass {
  if (description === undefined) return 'unknown'
  if (PAID_TAGS.some(tag => description.includes(tag))) return 'paid'
  const multipliers = modelMultipliers(description)
  if (multipliers.some(value => value === 0)) return 'free'
  if (multipliers.some(value => value > 0)) return 'paid'
  // A stated amount is a stated price, whether or not it is spelled as a
  // multiplier. All-zero amounts are the free case; a description that states
  // none at all stays unknown, so an unpriced row is never called either.
  const amounts = modelAmounts(description)
  if (amounts.length > 0) return amounts.some(value => value > 0) ? 'paid' : 'free'
  return FREE_SOURCES.has(modelSourceOf(description).toLowerCase()) ? 'free' : 'unknown'
}
