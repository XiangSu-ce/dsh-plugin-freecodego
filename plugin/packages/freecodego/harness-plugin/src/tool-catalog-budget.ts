/**
 * What a `tool_search` index costs, and what it becomes when that is too much.
 *
 * Why a budget at all
 * -------------------
 * The index is the one listing whose cost the plugin cannot pass on to a
 * discovery round-trip, so it is also the one that grows with the catalog. Today
 * it is 37 names and their first description lines (~3.7 KB, ~930 tokens); an
 * operator who sets `deferredToolNames` to a few hundred names, or mounts a
 * server whose tools all become deferrable, turns the cheapest call in the
 * plugin into the most expensive one. The listing is therefore priced, and it
 * degrades instead of growing.
 *
 * Three levels, in decreasing detail
 * ----------------------------------
 * - `full` — `name — first line of its description`. What the index has always
 *   been, and what it stays for a catalog that fits.
 * - `names` — the names alone, once the summaries do not fit.
 * - `grouped` — one line per name prefix with a count and a few samples, once
 *   even the names do not fit.
 *
 * Degrading is not truncating. A truncated listing silently hides tools: the
 * model cannot search for a name it has never seen, so a name dropped from the
 * index is a name that is gone from the session's surface. Every level here
 * instead says what it dropped and how to get it back — and the `list:` query
 * form (`deferred-tools.ts`) exists so that "get it back" is a real answer for
 * *every* name at *every* level, including one that grouping itself had to omit.
 *
 * Why the number
 * --------------
 * The deferred set this module was written against measures 14,380 chars of
 * schema, and its index measures about 930 tokens. A 1,000-token budget is
 * therefore "the index may not cost more than roughly a quarter of the schemas
 * it saves" — and it is deliberately just above today's catalog, so this change
 * is inert until a catalog actually outgrows it. The budget is a parameter
 * rather than a constant read here, so a caller that has different economics can
 * raise it without editing this module.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tool-catalog-budget
 */

import { tokensFromChars } from './token-estimate.ts'

/** One deferred tool, as much of it as a listing needs. */
export interface CatalogEntry {
  readonly name: string
  /** First line of the tool's description, when it has one. */
  readonly summary?: string
}

/** How much of the catalog the listing spells out. */
export type CatalogDetail = 'full' | 'names' | 'grouped'

/** One prefix line at the grouped level. */
export interface CatalogGroup {
  readonly prefix: string
  readonly count: number
  /** The names of this group that the listing spells out. */
  readonly samples: readonly string[]
}

/** A rendered index, with the arithmetic that produced it. */
export interface CatalogListing {
  readonly text: string
  readonly detail: CatalogDetail
  /** Names the text spells out. */
  readonly listed: number
  /** Names the text does not spell out; reachable through `list:`. */
  readonly omitted: number
  readonly tokens: number
  readonly budgetTokens: number
  readonly groups: readonly CatalogGroup[]
}

/**
 * Default ceiling for the index, in tokens (4 chars per token).
 *
 * See the module header for why 1,000: the deferred schemas it replaces measure
 * ~3,595 tokens, and a discovery listing that costs more than a quarter of what
 * deferral saved has stopped paying for itself.
 */
export const DEFAULT_CATALOG_TOKEN_BUDGET = 1_000

/** Names spelled out per group at the grouped level. */
const GROUP_SAMPLES = 3

/**
 * The prefix a name is grouped under.
 *
 * Deliberately crude: it is a display device, and the escape hatch (`list:`)
 * rather than this key is what guarantees every name stays reachable. A name
 * with no underscore at all is its own group.
 * @param name - the tool name.
 * @returns the leading identifier and its underscores.
 */
export function catalogPrefixOf(name: string): string {
  return /^[^_]*_+/u.exec(name)?.[0] ?? name
}

/**
 * Render the argument-less `tool_search` index under a token budget.
 *
 * An empty catalog returns an empty listing: the caller owns that sentence,
 * because only it knows whether the catalog is empty or the feature is off.
 * @param entries - the deferred tools, in registration order.
 * @param budgetTokens - ceiling for the rendered text.
 * @returns the listing, the level it settled at, and what it left out.
 */
export function renderToolCatalog(
  entries: readonly CatalogEntry[],
  budgetTokens: number = DEFAULT_CATALOG_TOKEN_BUDGET,
): CatalogListing {
  const budget = Number.isFinite(budgetTokens) && budgetTokens > 0 ? budgetTokens : DEFAULT_CATALOG_TOKEN_BUDGET
  if (entries.length === 0) {
    return { text: '', detail: 'full', listed: 0, omitted: 0, tokens: 0, budgetTokens: budget, groups: [] }
  }
  const first = entries[0]?.name ?? ''
  const hint = `Fetch any of these by name, e.g. tool_search("select:${first}"), or search by keyword, e.g. tool_search("memory search").`
  const full = entries.map(entry => `- ${entry.name}${entry.summary === undefined || entry.summary === '' ? '' : ` — ${entry.summary}`}`.trimEnd())
  const fullText = atLevel(full, hint)
  if (priced(fullText) <= budget) {
    return { text: fullText, detail: 'full', listed: entries.length, omitted: 0, tokens: priced(fullText), budgetTokens: budget, groups: [] }
  }

  const names = entries.map(entry => `- ${entry.name}`)
  // The footer names the dropped detail rather than only dropping it, so a model
  // that wants a summary knows a keyword search is what returns one.
  const namesFooter = `Summaries are omitted to keep this listing inside its ${String(budget)}-token budget. Fetch one by name, e.g. tool_search("select:${first}"), or search by keyword to get a summary and the schema together.`
  const namesText = atLevel(names, namesFooter)
  if (priced(namesText) <= budget) {
    return { text: namesText, detail: 'names', listed: entries.length, omitted: 0, tokens: priced(namesText), budgetTokens: budget, groups: [] }
  }

  return renderGrouped(entries, budget)
}

/** Price a rendered listing at the one density the plugin estimates with. */
function priced(text: string): number {
  return tokensFromChars(text.length)
}

/** A listing's body and its footer, in the one shape every level ships. */
function atLevel(lines: readonly string[], footer: string): string {
  return `${lines.join('\n')}\n\n${footer}`
}

/** The grouped level: one line per prefix, bounded by the same budget. */
function renderGrouped(entries: readonly CatalogEntry[], budget: number): CatalogListing {
  const byPrefix = new Map<string, string[]>()
  for (const entry of entries) {
    const prefix = catalogPrefixOf(entry.name)
    const names = byPrefix.get(prefix)
    if (names === undefined) byPrefix.set(prefix, [entry.name])
    else names.push(entry.name)
  }
  // Largest groups first: they are the ones most likely to hold the tool the
  // model is looking for, and the ones whose omission costs the most.
  const ordered = [...byPrefix.entries()]
    .map(([prefix, names]) => ({ prefix, names }))
    .sort((left, right) => right.names.length - left.names.length || left.prefix.localeCompare(right.prefix))

  const totalNames = ordered.reduce((total, group) => total + group.names.length, 0)
  const footerWith = (shown: number): string => {
    const rest = ordered.length - shown
    const tail = rest === 0
      ? ''
      : ` ${String(rest)} further group${rest === 1 ? '' : 's'} did not fit; tool_search("list:all") returns every name.`
    return `This listing is grouped because the names do not fit its ${String(budget)}-token budget. tool_search("list:<prefix>") returns one group's names; tool_search("list:all") returns every deferred name; both are names only, so fetch a schema with tool_search("select:<name>").${tail}`
  }

  const shown: CatalogGroup[] = []
  for (const group of ordered) {
    const samples = group.names.slice(0, GROUP_SAMPLES)
    const line = `- ${group.prefix} (${String(group.names.length)} tools): ${samples.join(', ')}${group.names.length > samples.length ? `, +${String(group.names.length - samples.length)} more` : ''}`
    const lines = [...shown.map(renderedLine), line]
    // Price the candidate line with the footer it would ship with, so the level
    // cannot exceed the budget by the size of its own explanation. The first group
    // is taken whatever it prices at — see the `shown.length > 0` guard — because
    // the two guarantees this module makes (stay inside the budget, and say what you
    // dropped) cannot both hold when the budget is smaller than one group line, and
    // an index that answered with nothing at all would hide every name it has. The
    // overshoot is bounded by one group line and is visible in `tokens` against
    // `budgetTokens`, which is what a caller needs to notice the budget is too small.
    const text = atLevel(lines, footerWith(shown.length + 1))
    if (shown.length > 0 && priced(text) > budget) break
    shown.push({ prefix: group.prefix, count: group.names.length, samples })
  }

  const text = atLevel(shown.map(renderedLine), footerWith(shown.length))
  const listed = shown.reduce((total, group) => total + group.samples.length, 0)
  const omitted = totalNames - listed
  return { text, detail: 'grouped', listed, omitted, tokens: priced(text), budgetTokens: budget, groups: shown }
}

/** One rendered group line, from the group it describes. */
function renderedLine(group: CatalogGroup): string {
  const more = group.count - group.samples.length
  return `- ${group.prefix} (${String(group.count)} tools): ${group.samples.join(', ')}${more > 0 ? `, +${String(more)} more` : ''}`
}

/**
 * The names-only listing behind `list:<prefix>`.
 *
 * This is the level-independent guarantee that the index never hides a name: it
 * is bounded, so it can be asked for whatever the index had to omit, and it
 * deliberately returns no schemas — a name alone is not callable, and a listing
 * that pretended otherwise would leave the model calling a tool the session has
 * never been shown.
 * @param entries - the deferred tools.
 * @param prefix - the name prefix to list; empty or `all` lists everything.
 * @param limit - most names to spell out before the listing says how many are left.
 * @returns the listing text.
 */
export function renderDeferredNameList(
  entries: readonly CatalogEntry[],
  prefix: string,
  limit = 60,
): string {
  const wanted = prefix.trim().toLowerCase()
  const all = wanted === '' || wanted === 'all'
  const matched = all ? entries : entries.filter(entry => entry.name.toLowerCase().startsWith(wanted))
  if (matched.length === 0) {
    const available = [...new Set(entries.map(entry => catalogPrefixOf(entry.name)))].sort().join(', ')
    return `No deferred tool name starts with "${prefix.trim()}". Groups: ${available === '' ? '(none)' : available}. Use tool_search("list:all") for every name.`
  }
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 60
  const shown = matched.slice(0, cap)
  const rest = matched.length - shown.length
  // Two ways on, because one of them always exists: narrowing keeps a long group
  // listable, and a keyword search reaches the one name of a group whose prefix
  // is already as narrow as it gets.
  const tail = rest === 0
    ? ''
    : `\n… and ${String(rest)} more; narrow the prefix, or search for the one you want with tool_search("<keyword>").`
  return `${shown.map(entry => entry.name).join('\n')}${tail}\n\nFetch one by name with tool_search("select:<name>"); a name listed here is not callable until its schema is fetched.`
}
