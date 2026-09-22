/**
 * Choosing a default media model from a live catalog.
 *
 * The catalog is a live window onto third-party directories: entries appear,
 * get renamed, and get retired without notice. A stored default therefore has
 * three possible states, and the previous implementation only handled two of
 * them — a retired id was left in the settings document forever, and the
 * automatic first pick took whichever row the directory happened to return
 * first, which is how a workflow default ended up pointing at a model nobody
 * chose.
 *
 * This module owns the whole decision so it can be reasoned about and tested
 * without a browser: given the available models, the stored value, and any
 * operator preference, it says what the default should become.
 *
 * @module dsh-freecodego-harness-ui/client/media-default-preference
 */

/** Catalog row shape this decision needs; a structural subset of the catalog. */
export interface MediaDefaultCandidate {
  readonly id: string
  readonly provider: string
  readonly displayName: string
}

/**
 * Providers preferred when nothing else distinguishes two candidates.
 *
 * Order is deliberate, not alphabetical: the plugin's own managed routes come
 * first because they are the ones the plugin can reason about and meter, then
 * the community gateways. An unknown provider sorts last rather than first, so
 * a new third-party entry can never silently become every user's default.
 */
const PROVIDER_PREFERENCE: readonly string[] = [
  'agnes',
  'freecodego',
  'logfare',
  'opencode',
  'openrouter',
  'sensenova',
  'workbuddy',
  'trae',
]

/**
 * Rank one candidate for automatic selection; lower is better.
 *
 * Ties fall through to the display name so the choice is stable across reloads
 * rather than following whatever order the directory returned.
 *
 * @param candidate - one available model in the target category.
 * @returns the sort key; compare with `<` for descending preference.
 */
export function mediaDefaultRank(candidate: MediaDefaultCandidate): number {
  const provider = candidate.provider.trim().toLowerCase()
  const index = PROVIDER_PREFERENCE.indexOf(provider)
  return index === -1 ? PROVIDER_PREFERENCE.length : index
}

/** Sort candidates by preference, then by display name for stability. 
 * @returns the media Default Candidate rows, in backend order.
 * @param candidates - the available models to order.
 */
export function rankMediaDefaults(candidates: readonly MediaDefaultCandidate[]): readonly MediaDefaultCandidate[] {
  return [...candidates].sort((left, right) =>
    mediaDefaultRank(left) - mediaDefaultRank(right)
    || left.displayName.localeCompare(right.displayName)
    || left.id.localeCompare(right.id))
}

/**
 * What the stored default should become.
 *
 * - `keep` — the stored id is present and usable; nothing to do.
 * - `migrate` — the stored id is gone but exactly one available model carries
 *   it as a `provider/id` suffix, so the route survived a prefix change.
 * - `replace` — the stored id cannot be honoured. `next` is the preferred
 *   available model, or undefined when the category has nothing at all.
 * - `unset` — nothing is stored and nothing is available; leave it empty rather
 *   than persisting a model that does not exist.
 *
 * A stored id that the catalog still lists but cannot use right now also keeps
 * its value: the route exists, the generation path falls back to another route
 * of the same category, and the alternative — rewriting a setting the user
 * chose because of a provider status the panel re-derives on every render — is
 * how a saved default disappeared on the next open.
 */
export type MediaDefaultDecision =
  | { readonly action: 'keep' }
  | { readonly action: 'migrate'; readonly next: string }
  | { readonly action: 'replace'; readonly next: string }
  | { readonly action: 'unset' }

/**
 * Decide the default for one media category.
 *
 * @param stored - the currently persisted default, possibly empty or retired.
 * @param available - models the live catalog reports as usable for the category.
 * @param known - every model the catalog lists for the category, whether it is
 *   usable or not. Defaults to `available` for callers holding no wider view;
 *   the settings panel passes the full list, which is what keeps a stored
 *   default through a temporary outage (Logfare rows are marked unavailable
 *   until its credentials are configured).
 * @returns the decision, plus the id to persist when one is needed.
 */
export function decideMediaDefault(stored: string, available: readonly MediaDefaultCandidate[], known: readonly MediaDefaultCandidate[] = available): MediaDefaultDecision {
  const current = stored.trim()
  if (current === '') {
    // Nothing stored: adopt the preferred model rather than the first row, and
    // leave the setting empty when the category has nothing to offer.
    const preferred = rankMediaDefaults(available)[0]
    return preferred === undefined ? { action: 'unset' } : { action: 'replace', next: preferred.id }
  }
  if (available.some(candidate => candidate.id === current)) return { action: 'keep' }
  // The route may have survived a provider-prefix change (`gpt-image-2` →
  // `logfare/gpt-image-2`); a single unambiguous match is that same route.
  const suffixMatches = available.filter(candidate => candidate.id.endsWith(`/${current}`))
  if (suffixMatches.length === 1) return { action: 'migrate', next: suffixMatches[0]!.id }
  // Listed but not usable right now: a temporary outage is not a retirement.
  if (known.some(candidate => candidate.id === current)) return { action: 'keep' }
  const preferred = rankMediaDefaults(available)[0]
  // A retired model is replaced, never kept: the previous behaviour left the
  // dead id in place, so the stored default pointed at a route that had been
  // withdrawn and every generation failed with a provider error.
  return preferred === undefined ? { action: 'unset' } : { action: 'replace', next: preferred.id }
}
