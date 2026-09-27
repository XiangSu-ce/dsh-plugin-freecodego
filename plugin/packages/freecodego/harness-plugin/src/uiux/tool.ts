/**
 * The model-facing UI/UX catalogue search tool.
 *
 * One bounded tool covers the curated design domains and the framework tables:
 * the model can choose a domain, name a stack, or let the catalogue route the
 * request. Results keep the calibrated search diagnostics, and identity-shaped
 * style requests resolve declared successors before they can rank as current.
 *
 * This module owns the *definition* and not a registration. The tool is one row
 * on the design page, so the switch for that row is what registers it — driven by
 * `design/features.ts` and registered by the design pack's name table. A second
 * registration path here would let the page say a capability is off while a
 * caller could still reach its tool.
 *
 * @module uiux/tool
 */

import { JSON_TOOL_OUTPUT, toolDefinition, type ToolDefinitionShape } from '../tool-definition.ts'
import {
  DOMAIN_TABLES,
  PRODUCT_KEYWORD_SEED,
  STACK_COLUMNS,
  STACKS,
  detectDomain,
  rewriteQueryForDomain,
  stackThreshold,
  thresholdForDomain,
  type Domain,
} from './catalog.ts'
import { fitBm25 } from './bm25.ts'
import {
  loadDomain,
  loadStack,
  type CatalogLoadOutcome,
} from './data-store.ts'
import {
  hasExactIdentityDeclaration,
  resolveLandingIdentity,
  resolveStyleIdentity,
  type StyleResolution,
} from './generations.ts'
import {
  projectRow,
  searchDomain,
  type DomainSearchOutcome,
  type SearchRow,
} from './search.ts'

/** Registered tool name; prefixed so Harness deferral and Plan Mode classify it. */
export const UIUX_SEARCH_TOOL_NAME = 'freecodego_uiux_search'

/** Maximum query text kept out of the search index and tool transcript. */
const MAX_QUERY_LENGTH = 1_000

/** Inputs accepted by the UI/UX search tool. */
interface UiuxSearchArgs {
  readonly query?: unknown
  readonly domain?: unknown
  readonly stack?: unknown
  readonly max_results?: unknown
}

/** A tool refusal that states what prevented a search from running. */
interface UiuxToolRefusal {
  readonly kind: 'refused'
  readonly query: string
  readonly reason: string
  readonly message: string
  readonly domain?: string
  readonly stack?: string
  readonly warnings?: readonly string[]
}

/** Which corpus the caller asked this tool to search. */
type UiuxSelection =
  | { readonly kind: 'domain'; readonly domain: Domain; readonly strategy: 'explicit' | 'automatic'; readonly runnerUp?: Domain }
  | { readonly kind: 'stack'; readonly stack: string }

/** A search result with the route and any data-drift warnings kept beside it. */
interface UiuxSearchResult {
  readonly kind: 'searched'
  readonly query: string
  readonly selection: UiuxSelection
  readonly warnings: readonly string[]
  readonly outcome: DomainSearchOutcome
}

/** An identity match or declared cross-domain redirect resolved before ranking. */
interface UiuxIdentityResult {
  readonly kind: 'identity'
  readonly query: string
  readonly domain: 'style' | 'landing'
  readonly resultDomain: 'style' | 'landing'
  readonly identity: Readonly<Record<string, unknown>>
  readonly results: readonly SearchRow[]
  readonly warnings: readonly string[]
}

/** Complete response union so tool callers can distinguish search from refusal. */
type UiuxSearchResponse = UiuxSearchResult | UiuxIdentityResult | UiuxToolRefusal

/** Table-load refusal in the same sentence-shaped form returned to a tool caller. */
function refusedLoad(
  query: string,
  outcome: Extract<CatalogLoadOutcome, { readonly kind: 'refused' }>,
  warnings: readonly string[] = [],
  scope: { readonly domain?: string; readonly stack?: string } = {},
): UiuxToolRefusal {
  return {
    kind: 'refused', query, reason: outcome.reason, message: outcome.message,
    ...scope.domain === undefined ? {} : { domain: scope.domain },
    ...scope.stack === undefined ? {} : { stack: scope.stack },
    ...(warnings.length === 0 ? {} : { warnings }),
  }
}

/** Load product labels for routing, with a measured built-in vocabulary fallback. */
function routingKeywords(): { readonly keywords: readonly string[]; readonly warnings: readonly string[] } {
  const product = loadDomain('product')
  if (product.kind !== 'loaded') {
    return {
      keywords: PRODUCT_KEYWORD_SEED,
      warnings: [`Automatic routing used its built-in product vocabulary because ${product.message}`],
    }
  }
  const keywords = product.rows
    .map(row => (row['Product Type'] ?? '').trim())
    .filter(value => value !== '')
  return { keywords: keywords.length === 0 ? PRODUCT_KEYWORD_SEED : keywords, warnings: product.warnings }
}

/** Build lexical vocabulary with the same columns the selected search will score. */
function vocabulary(rows: readonly SearchRow[], columns: readonly string[]): ReadonlySet<string> {
  const documents = rows.map(row => columns.map(column => row[column] ?? '').join(' '))
  return new Set(fitBm25(documents).vocabulary)
}

/** Return a user-facing refusal without reaching into any workspace files. */
function refusal(
  query: string,
  reason: string,
  message: string,
  extra: { readonly domain?: string; readonly stack?: string; readonly warnings?: readonly string[] } = {},
): UiuxToolRefusal {
  return {
    kind: 'refused', query, reason, message,
    ...extra.domain === undefined ? {} : { domain: extra.domain },
    ...extra.stack === undefined ? {} : { stack: extra.stack },
    ...extra.warnings === undefined || extra.warnings.length === 0 ? {} : { warnings: extra.warnings },
  }
}

/** Project one identity resolution to a single tool result or an explicit refusal. */
function styleIdentityResult(
  query: string,
  resolution: StyleResolution,
  landingOutcome: CatalogLoadOutcome | undefined,
): UiuxIdentityResult | UiuxToolRefusal | undefined {
  if (resolution.kind === 'miss') return undefined
  if (resolution.kind === 'ambiguous') {
    return refusal(
      query,
      'ambiguous-identity',
      `The style identity ${JSON.stringify(resolution.identity)} is ambiguous; choose a unique style ID or alias.`,
      { domain: 'style' },
    )
  }
  if (resolution.kind === 'unresolved') {
    if (landingOutcome?.kind === 'refused'
      && resolution.reason === 'missing-successor'
      && resolution.detail.includes('landing replacement')) {
      return refusedLoad(query, landingOutcome, [], { domain: 'style' })
    }
    return refusal(query, 'unresolved-identity', resolution.detail, { domain: 'style' })
  }
  if (resolution.kind === 'matched') {
    return {
      kind: 'identity',
      query,
      domain: 'style',
      resultDomain: 'style',
      identity: { id: resolution.row['Style ID'] ?? '', reason: resolution.reason, trail: resolution.trail },
      results: [projectRow(resolution.row, DOMAIN_TABLES.style.outputColumns)],
      warnings: [],
    }
  }
  if (resolution.domain !== 'landing') {
    return refusal(
      query,
      'unsupported-identity-redirect',
      `Deprecated style ${resolution.sourceId} redirects to unsupported domain ${resolution.domain}.`,
      { domain: 'style' },
    )
  }
  if (landingOutcome === undefined) {
    return refusal(query, 'unresolved-identity', `The declared landing redirect ${resolution.id} was not validated.`, {
      domain: 'style',
    })
  }
  if (landingOutcome.kind !== 'loaded') {
    return refusedLoad(query, landingOutcome, [], { domain: 'style' })
  }
  const targets = landingOutcome.rows.filter(row => (row['Pattern ID'] ?? '').trim() === resolution.id)
  const target = targets[0]
  if (target === undefined || targets.length !== 1) {
    return refusal(query, 'unresolved-identity', `The declared landing redirect ${resolution.id} is missing or ambiguous.`, {
      domain: 'style', warnings: landingOutcome.warnings,
    })
  }
  return {
    kind: 'identity',
    query,
    domain: 'style',
    resultDomain: 'landing',
    identity: { id: resolution.id, sourceId: resolution.sourceId, reason: 'cross-domain-redirect', trail: resolution.trail },
    results: [projectRow(target, DOMAIN_TABLES.landing.outputColumns)],
    warnings: landingOutcome.warnings,
  }
}

/** Return an exact landing identity, refusing an exact identity that is ambiguous. */
function landingIdentityResult(query: string, rows: readonly SearchRow[]): UiuxIdentityResult | UiuxToolRefusal | undefined {
  const match = resolveLandingIdentity(rows, query)
  if (match !== undefined) {
    return {
      kind: 'identity',
      query,
      domain: 'landing',
      resultDomain: 'landing',
      identity: { id: match.id, matchedBy: match.field },
      results: [projectRow(match.row, DOMAIN_TABLES.landing.outputColumns)],
      warnings: [],
    }
  }
  if (hasExactIdentityDeclaration(rows, query, ['Pattern ID', 'Pattern Name', 'Aliases'])) {
    return refusal(
      query,
      'ambiguous-identity',
      `The landing identity ${JSON.stringify(query.trim())} is ambiguous; choose a unique pattern ID or alias.`,
      { domain: 'landing' },
    )
  }
  return undefined
}

/** Search the validated built-in catalogue or one named framework table. */
function runUiuxSearch(input: unknown): UiuxSearchResponse {
  if (typeof input !== 'object' || input === null) {
    return refusal('', 'invalid-arguments', 'Provide a JSON object with a non-empty query.')
  }
  const args = input as UiuxSearchArgs
  if (typeof args.query !== 'string') {
    return refusal('', 'invalid-query', 'query must be a non-empty string.')
  }
  const query = args.query.trim()
  if (query === '') return refusal(query, 'empty-query', 'Provide a non-empty UI/UX search query.')
  if (query.length > MAX_QUERY_LENGTH) {
    return refusal(query.slice(0, MAX_QUERY_LENGTH), 'query-too-long', `The query exceeds ${String(MAX_QUERY_LENGTH)} characters.`)
  }
  const maxResults = args.max_results === undefined ? 3 : args.max_results
  if (typeof maxResults !== 'number' || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > 20) {
    return refusal(query, 'invalid-limit', 'max_results must be an integer from 1 to 20.')
  }
  const explicitDomain = args.domain
  if (explicitDomain !== undefined && typeof explicitDomain !== 'string') {
    return refusal(query, 'invalid-domain', 'domain must be one of the catalogue domain names.')
  }
  const stack = args.stack
  if (stack !== undefined && typeof stack !== 'string') {
    return refusal(query, 'invalid-stack', 'stack must be one of the framework identifiers.')
  }
  if (explicitDomain !== undefined && stack !== undefined) {
    return refusal(query, 'invalid-selection', 'Choose either a domain or a framework stack, not both.')
  }
  if (stack !== undefined) {
    const loaded = loadStack(stack)
    if (loaded.kind !== 'loaded') return refusedLoad(query, loaded, [], { stack })
    const outcome = searchDomain(loaded.rows, {
      domain: `stack:${stack}`,
      query,
      searchColumns: STACK_COLUMNS.searchColumns,
      outputColumns: STACK_COLUMNS.outputColumns,
      threshold: stackThreshold(),
      maxResults,
    })
    return {
      kind: 'searched',
      query,
      selection: { kind: 'stack', stack },
      warnings: loaded.warnings,
      outcome,
    }
  }

  if (explicitDomain !== undefined && !Object.hasOwn(DOMAIN_TABLES, explicitDomain)) {
    return refusal(query, 'unknown-domain', `Unknown UI/UX domain ${JSON.stringify(explicitDomain)}.`)
  }
  const routing = explicitDomain === undefined ? routingKeywords() : undefined
  const route = routing === undefined ? undefined : detectDomain(query, routing.keywords)
  const domain = explicitDomain === undefined ? route?.domain ?? 'style' : explicitDomain as Domain
  const loaded = loadDomain(domain)
  if (loaded.kind !== 'loaded') return refusedLoad(query, loaded, routing?.warnings)
  const warnings = [...(routing?.warnings ?? []), ...loaded.warnings]

  if (domain === 'style') {
    let resolution = resolveStyleIdentity(loaded.rows, query)
    let landing: CatalogLoadOutcome | undefined
    // The resolver validates redirects before emitting one. A first pass without
    // the optional landing table distinguishes ordinary styles from this one case.
    if (resolution.kind === 'unresolved'
      && resolution.reason === 'missing-successor'
      && resolution.detail.includes('landing replacement')) {
      landing = loadDomain('landing')
      if (landing.kind === 'loaded') {
        resolution = resolveStyleIdentity(loaded.rows, query, true, landing.rows)
      }
    }
    const identity = styleIdentityResult(query, resolution, landing)
    if (identity !== undefined) {
      return identity.kind === 'refused'
        ? { ...identity, warnings: [...warnings, ...(identity.warnings ?? [])] }
        : { ...identity, warnings: [...warnings, ...identity.warnings] }
    }
  }
  if (domain === 'landing') {
    const identity = landingIdentityResult(query, loaded.rows)
    if (identity !== undefined) {
      return identity.kind === 'refused'
        ? { ...identity, warnings: [...warnings, ...(identity.warnings ?? [])] }
        : { ...identity, warnings: [...warnings, ...identity.warnings] }
    }
  }

  // Deprecated styles are still available to the identity resolver above, but
  // never enter ordinary ranking as a current recommendation.
  const rows = domain === 'style'
    ? loaded.rows.filter(row => (row.Status ?? '').trim().toLowerCase() !== 'deprecated')
    : loaded.rows
  const table = DOMAIN_TABLES[domain]
  const rewritten = rewriteQueryForDomain(query, domain, vocabulary(rows, table.searchColumns))
  const outcome = searchDomain(rows, {
    domain,
    query,
    searchColumns: table.searchColumns,
    outputColumns: table.outputColumns,
    threshold: thresholdForDomain(domain),
    maxResults,
    searchQuery: rewritten.searchQuery,
    queryRewrites: rewritten.rewrites,
  })
  return {
    kind: 'searched',
    query,
    selection: {
      kind: 'domain',
      domain,
      strategy: explicitDomain === undefined ? 'automatic' : 'explicit',
      ...(route?.runnerUp === undefined ? {} : { runnerUp: route.runnerUp }),
    },
    warnings,
    outcome,
  }
}

/**
 * The tool definition this package ships, built on demand.
 *
 * The definition rather than a registration, because the design pack registers
 * tools by name and reports the names that registered: `design/features.ts`
 * lists {@link UIUX_SEARCH_TOOL_NAME} as the catalogue row's tool, and
 * `design/tools.ts` supplies this builder under that same name. One name, one
 * builder — a literal written at each site is a row on the design page that can
 * advertise a tool this build never registered.
 *
 * @returns the definition, named {@link UIUX_SEARCH_TOOL_NAME}.
 */
export function uiuxSearchToolDefinition(): ToolDefinitionShape {
  return toolDefinition({
    name: UIUX_SEARCH_TOOL_NAME,
    description: 'Search the bundled UI/UX Pro Max catalogue for design patterns, product guidance, palettes, typography, landing pages, accessibility, charts, icons, animation and implementation guidelines. Set domain to target one of the 11 curated domains, stack to search one of the 22 framework guideline tables, or omit both to route automatically. Results include calibrated confidence diagnostics; low-confidence matches are reported as abstentions, never as recommendations. Exact style and landing identities resolve before ranking, including declared deprecated-style successors. Read-only; this tool never reads or writes the project workspace.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, maxLength: MAX_QUERY_LENGTH, description: 'The UI/UX question or search phrase.' },
        domain: { type: 'string', enum: Object.keys(DOMAIN_TABLES), description: 'Optional explicit domain; omit to route automatically.' },
        stack: { type: 'string', enum: STACKS, description: 'Optional framework identifier such as nextjs, react, vue or swiftui. Mutually exclusive with domain.' },
        max_results: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum ranked rows; defaults to 3.' },
      },
    },
    output: JSON_TOOL_OUTPUT,
    isConcurrencySafe: () => true,
    execute: (args: UiuxSearchArgs) => runUiuxSearch(args),
    presentCall: (args: UiuxSearchArgs) => ({
      card: 'generic',
      title: `UI/UX search: ${typeof args.query === 'string' ? args.query.slice(0, 72) : ''}`,
    }),
  })
}
