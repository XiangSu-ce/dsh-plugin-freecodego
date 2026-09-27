/**
 * Resolve public style and landing-page identities before fuzzy ranking.
 *
 * Why identities are handled ahead of the score
 * ---------------------------------------------
 * A stable ID or a declared alias is a statement of intent, not a bag of words. It
 * should not lose to a different row because a popular token has low IDF; nor should
 * an explicit retired style be retrieved from the live ranking and presented as
 * current. The resolver handles those identity-shaped inputs first, then returns a
 * successor or a cross-domain redirect rather than inventing a style answer.
 *
 * What stays a miss
 * -----------------
 * A partial alias, a phrase that merely shares a substring, an ambiguous contained
 * identity, a dangling parent and a redirect to a domain this catalog does not load
 * are not matches. Each has a different tempting fallback — choose the first, return
 * the deprecated row, or guess the target — and each would turn missing evidence into
 * a result. The output union forces the caller to distinguish them.
 *
 * @module uiux/generations
 */

import { normalizeQuery } from './bm25.ts'
import type { Domain } from './catalog.ts'
import type { SearchRow } from './search.ts'

/** Fields that identify a visual style in the source catalog. */
export const STYLE_IDENTITY_FIELDS = ['Style ID', 'Style Category', 'Aliases'] as const
/** Fields that identify a landing pattern in the source catalog. */
export const LANDING_IDENTITY_FIELDS = ['Pattern ID', 'Pattern Name', 'Aliases'] as const

/** A declaration of a stable identity's column. */
export type IdentityField = typeof STYLE_IDENTITY_FIELDS[number] | typeof LANDING_IDENTITY_FIELDS[number]

/** A style is resolved, redirected to a supported other domain, explicitly unresolved, or not an identity. */
export type StyleResolution =
  | {
    readonly kind: 'matched'
    readonly row: SearchRow
    readonly reason: 'exact-identity' | 'contained-identity' | 'parent-style' | 'style-replacement'
    /** Deprecated IDs traversed, oldest first. Empty for a live identity. */
    readonly trail: readonly string[]
  }
  | {
    readonly kind: 'redirect'
    readonly domain: Exclude<Domain, 'style'>
    readonly id: string
    readonly sourceId: string
    readonly trail: readonly string[]
  }
  | {
    readonly kind: 'unresolved'
    readonly sourceId: string
    readonly reason: 'missing-successor' | 'successor-cycle' | 'unsupported-domain'
    readonly detail: string
    readonly trail: readonly string[]
  }
  | {
    readonly kind: 'ambiguous'
    readonly identity: string
    readonly match: 'exact' | 'contained'
  }
  | { readonly kind: 'miss' }

/** A landing pattern explicitly resolved by ID, name, or declared alias. */
export interface LandingIdentityMatch {
  /** The matching row. */
  readonly row: SearchRow
  /** Which public identity field matched. */
  readonly field: typeof LANDING_IDENTITY_FIELDS[number]
  /** The canonical ID other callers should carry forward. */
  readonly id: string
}

/**
 * Read declared names from identity fields.
 *
 * Aliases are pipe-delimited in the upstream data; splitting any other field would
 * mutate a display value into multiple identities. Empty and whitespace-only aliases
 * carry no identity.
 *
 * @param row - the source catalog row.
 * @param fields - the columns that form public identity.
 * @returns non-empty identities in field and source order.
 */
export function rowIdentities(row: SearchRow, fields: readonly IdentityField[]): readonly {
  readonly field: IdentityField
  readonly value: string
}[] {
  const identities: { field: IdentityField; value: string }[] = []
  for (const field of fields) {
    const cell = row[field] ?? ''
    const values = field === 'Aliases' ? cell.split('|') : [cell]
    for (const value of values) {
      const trimmed = value.trim()
      if (trimmed !== '') identities.push({ field, value: trimmed })
    }
  }
  return identities
}

/** Canonical row key by the identity table's first declared column. */
function canonicalId(row: SearchRow, fields: readonly IdentityField[]): string {
  const key = fields[0]
  return key === undefined ? '' : (row[key] ?? '').trim()
}

/**
 * Find one exact public identity without opening ranked search.
 *
 * If the same identity is declared by multiple distinct canonical rows, it is not
 * stable enough to resolve; returning the first would turn file order into unspoken
 * precedence. Repeated declarations on one row are still one identity.
 *
 * @param rows - catalog rows in file order.
 * @param query - the caller's phrase.
 * @param fields - the columns the source declares as identities.
 * @returns the unique row/field/id, or `undefined` when there is no unique exact match.
 */
export function exactIdentity<T extends IdentityField>(
  rows: readonly SearchRow[],
  query: string,
  fields: readonly T[],
): { readonly row: SearchRow; readonly field: T; readonly id: string } | undefined {
  const folded = query.trim().toLowerCase()
  if (folded === '' || fields.length === 0) return undefined
  // The supplied field order is the source's precedence: a declared stable ID wins
  // over a different row that happens to use the same text as an alias.
  for (const field of fields) {
    const matches = rows.flatMap(row => rowIdentities(row, [field])
      .filter(identity => identity.value.toLowerCase() === folded)
      .map(identity => ({ row, field: identity.field as T })))
    const distinctRows = new Set(matches.map(match => match.row))
    if (distinctRows.size === 0) continue
    if (distinctRows.size !== 1) return undefined
    const first = matches[0]
    if (first === undefined) return undefined
    const id = canonicalId(first.row, fields)
    if (id === '') return undefined
    return { ...first, id }
  }
  return undefined
}

/**
 * Whether a query is explicitly declared as an identity, even if multiple rows claim it.
 *
 * Callers that would otherwise fall through to fuzzy ranking can use this to keep
 * an ambiguous explicit ID or alias from being silently replaced by a weaker match.
 *
 * @param rows - rows from the identity table.
 * @param query - the caller's phrase.
 * @param fields - columns that declare public identities.
 * @returns true when at least one declared identity exactly matches the query.
 */
export function hasExactIdentityDeclaration(
  rows: readonly SearchRow[],
  query: string,
  fields: readonly IdentityField[],
): boolean {
  const folded = query.trim().toLowerCase()
  return folded !== '' && rows.some(row => rowIdentities(row, fields).some(identity => identity.value.toLowerCase() === folded))
}

/** A complete contained-style candidate before its tie is resolved. */
interface ContainedStyleCandidate {
  readonly row: SearchRow
  readonly identity: string
  readonly distinctiveness: number
  readonly tokenCount: number
}

/** The outcome that lets a caller distinguish no contained style from a tied one. */
type ContainedStyleIdentityResult =
  | { readonly kind: 'matched'; readonly row: SearchRow; readonly identity: string }
  | { readonly kind: 'ambiguous'; readonly identity: string }
  | { readonly kind: 'miss' }

/** Choose a unique most-distinctive contained style, retaining ambiguity as evidence. */
function findContainedStyleIdentity(rows: readonly SearchRow[], query: string): ContainedStyleIdentityResult {
  const queryTokens = identityTokens(query)
  if (queryTokens.size === 0) return { kind: 'miss' }
  const candidates: ContainedStyleCandidate[] = []
  for (const row of rows) {
    if ((row['Style ID'] ?? '').trim() === '') continue
    for (const { value } of rowIdentities(row, STYLE_IDENTITY_FIELDS)) {
      const tokens = identityTokens(value)
      if (tokens.size === 0 || [...tokens].some(token => !queryTokens.has(token))) continue
      // A generic one-word label (`page`, `style`) or a one-character label is not
      // a distinctive identity merely because it is fully contained in the prompt.
      if (![...tokens].some(token => Array.from(token).length >= 4)) continue
      const distinctiveness = [...tokens].filter(token => !GENERIC_IDENTITY_TOKENS.has(token)).length
      candidates.push({ row, identity: value, distinctiveness, tokenCount: tokens.size })
    }
  }
  candidates.sort((left, right) =>
    right.distinctiveness - left.distinctiveness
    || right.tokenCount - left.tokenCount
    || Array.from(right.identity).length - Array.from(left.identity).length)

  const first = candidates[0]
  if (first === undefined) return { kind: 'miss' }
  const tied = candidates.filter(candidate =>
    candidate.distinctiveness === first.distinctiveness
    && candidate.tokenCount === first.tokenCount
    && Array.from(candidate.identity).length === Array.from(first.identity).length)
  const distinctRows = new Set(tied.map(candidate => candidate.row))
  return distinctRows.size === 1
    ? { kind: 'matched', row: first.row, identity: first.identity }
    : { kind: 'ambiguous', identity: first.identity }
}

/** Generic identity words carry little evidence when an identity is contained in a longer request. */
const GENERIC_IDENTITY_TOKENS: ReadonlySet<string> = new Set([
  'app', 'design', 'interface', 'page', 'style', 'system', 'ui',
])

/** Tokenize an identity for contained-style matching using the catalog's synonyms and word boundaries. */
function identityTokens(value: string): ReadonlySet<string> {
  return new Set(normalizeQuery(value.toLowerCase()).match(/[\p{L}\p{N}_]+/gu) ?? [])
}

/**
 * Find the most distinctive complete style identity contained in a longer prompt.
 *
 * This is not fuzzy match: every non-stopword token of an identity must occur in the
 * request. Candidates are ranked by non-generic token count, total token count, then
 * source identity length, matching the upstream precedence. A tie between distinct
 * style IDs is an ambiguity, not permission to select the first row.
 *
 * @param rows - style rows, including supplemental and deprecated identities.
 * @param query - the wider user request.
 * @returns the unique best row, its matching identity, or `undefined` on miss/tie.
 */
export function containedStyleIdentity(
  rows: readonly SearchRow[],
  query: string,
): { readonly row: SearchRow; readonly identity: string } | undefined {
  const result = findContainedStyleIdentity(rows, query)
  return result.kind === 'matched' ? { row: result.row, identity: result.identity } : undefined
}

/**
 * Find a style row by stable ID without relying on row order.
 *
 * @param rows - the complete style table.
 * @param id - the canonical style ID.
 * @returns the unique matching row, or `undefined` when the ID is missing or duplicated.
 */
function uniqueStyleById(rows: readonly SearchRow[], id: string): SearchRow | undefined {
  const matches = rows.filter(row => (row['Style ID'] ?? '').trim() === id)
  return matches.length === 1 ? matches[0] : undefined
}

/** Find one landing row by its canonical pattern ID. */
function uniqueLandingById(rows: readonly SearchRow[], id: string): SearchRow | undefined {
  const matches = rows.filter(row => (row['Pattern ID'] ?? '').trim() === id)
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * Follow a deprecated style's local successor chain or return its declared domain redirect.
 *
 * Parent Style ID takes precedence over Replacement Domain/ID, just as the source
 * search does. A style replacement can itself be deprecated, so the resolver keeps
 * following the chain and detects cycles. A cross-domain redirect is returned as a
 * pointer only after its target resolves to one unique landing-pattern ID.
 *
 * @param rows - the complete style table, so IDs and successors can be verified.
 * @param source - the identity row that was found.
 * @param landingRows - landing rows used to validate cross-domain replacement IDs.
 * @returns the live/supplemental destination, explicit redirect, or refusal.
 */
export function resolveStyleDestination(
  rows: readonly SearchRow[],
  source: SearchRow,
  landingRows: readonly SearchRow[] = [],
): StyleResolution {
  const sourceId = (source['Style ID'] ?? '').trim()
  const sourceRow = uniqueStyleById(rows, sourceId)
  if (sourceId === '' || sourceRow === undefined) {
    return {
      kind: 'unresolved', sourceId, reason: 'missing-successor',
      detail: `Style identity ${sourceId || '(missing Style ID)'} is missing from or duplicated in its table.`, trail: [],
    }
  }
  let current = sourceRow
  const trail: string[] = []
  const visited = new Set<string>()
  while ((current.Status ?? 'active').trim().toLowerCase() === 'deprecated') {
    const currentId = (current['Style ID'] ?? '').trim()
    if (currentId === '' || visited.has(currentId)) {
      return {
        kind: 'unresolved', sourceId, reason: 'successor-cycle',
        detail: `Deprecated style successor cycle at ${currentId || '(missing Style ID)'}.`, trail,
      }
    }
    visited.add(currentId)
    trail.push(currentId)

    const parentId = (current['Parent Style ID'] ?? '').trim()
    if (parentId !== '') {
      const parent = uniqueStyleById(rows, parentId)
      if (parent === undefined) {
        return {
          kind: 'unresolved', sourceId, reason: 'missing-successor',
          detail: `Deprecated style ${currentId} names missing or duplicate parent ${parentId}.`, trail,
        }
      }
      current = parent
      continue
    }

    const replacementDomain = (current['Replacement Domain'] ?? '').trim().toLowerCase()
    const replacementId = (current['Replacement ID'] ?? '').trim()
    if (replacementDomain === '' || replacementId === '') {
      return {
        kind: 'unresolved', sourceId, reason: 'missing-successor',
        detail: `Deprecated style ${currentId} has no parent or complete replacement pointer.`, trail,
      }
    }
    if (replacementDomain === 'style') {
      const replacement = uniqueStyleById(rows, replacementId)
      if (replacement === undefined) {
        return {
          kind: 'unresolved', sourceId, reason: 'missing-successor',
          detail: `Deprecated style ${currentId} names missing or duplicate style replacement ${replacementId}.`, trail,
        }
      }
      current = replacement
      continue
    }
    if (replacementDomain !== 'landing') {
      return {
        kind: 'unresolved', sourceId, reason: 'unsupported-domain',
        detail: `Deprecated style ${currentId} redirects to unsupported domain ${replacementDomain}.`, trail,
      }
    }
    if (uniqueLandingById(landingRows, replacementId) === undefined) {
      return {
        kind: 'unresolved', sourceId, reason: 'missing-successor',
        detail: `Deprecated style ${currentId} names missing or ambiguous landing replacement ${replacementId}.`, trail,
      }
    }
    return { kind: 'redirect', domain: 'landing', id: replacementId, sourceId, trail }
  }
  const finalId = (current['Style ID'] ?? '').trim()
  if (sourceId === finalId) return { kind: 'matched', row: current, reason: 'exact-identity', trail: [] }
  const originalParent = (source['Parent Style ID'] ?? '').trim()
  return {
    kind: 'matched',
    row: current,
    reason: originalParent !== '' ? 'parent-style' : 'style-replacement',
    trail,
  }
}

/**
 * Resolve a style identity, optionally allowing a distinctive complete identity inside a longer query.
 *
 * @param rows - style rows, including non-active identity rows.
 * @param query - the user's style request.
 * @param allowContained - whether a complete identity may be contained in the request.
 * @param landingRows - landing rows used to validate cross-domain replacement IDs.
 * @returns the destination or redirect, or `miss` when no identity was stated.
 */
export function resolveStyleIdentity(
  rows: readonly SearchRow[],
  query: string,
  allowContained = true,
  landingRows: readonly SearchRow[] = [],
): StyleResolution {
  const exact = exactIdentity(rows, query, STYLE_IDENTITY_FIELDS)
  if (exact !== undefined) return resolveStyleDestination(rows, exact.row, landingRows)
  // An exact-but-ambiguous declaration is not permission to fall through and choose
  // whichever wider identity happens to win the contained-match tie-break.
  if (hasExactIdentityDeclaration(rows, query, STYLE_IDENTITY_FIELDS)) {
    return { kind: 'ambiguous', identity: query.trim(), match: 'exact' }
  }
  if (!allowContained) return { kind: 'miss' }
  const contained = findContainedStyleIdentity(rows, query)
  if (contained.kind === 'ambiguous') return { kind: 'ambiguous', identity: contained.identity, match: 'contained' }
  if (contained.kind === 'miss') return { kind: 'miss' }
  const destination = resolveStyleDestination(rows, contained.row, landingRows)
  if (destination.kind === 'matched' && destination.reason === 'exact-identity') {
    return { ...destination, reason: 'contained-identity' }
  }
  return destination
}

/**
 * Resolve one explicit landing identity by exact ID, name, or declared alias.
 *
 * @param rows - landing rows.
 * @param query - the phrase stated by the caller.
 * @returns a unique canonical pattern row or `undefined` when absent/ambiguous.
 */
export function resolveLandingIdentity(
  rows: readonly SearchRow[],
  query: string,
): LandingIdentityMatch | undefined {
  const match = exactIdentity(rows, query, LANDING_IDENTITY_FIELDS)
  if (match === undefined) return undefined
  const row = uniqueLandingById(rows, match.id)
  if (row === undefined) return undefined
  return { row, field: match.field, id: match.id }
}
