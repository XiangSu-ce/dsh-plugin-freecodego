/**
 * Semantic recall over durable engineering memory.
 *
 * Why this exists next to `lexicalRelevance`
 * -----------------------------------------
 * `engineering-memory.ts` already reranks FTS hits with a deterministic lexical
 * score, and its own comment calls that "the local stand-in for the embedding
 * rerank a hosted memory service would use". That stand-in is good at what it
 * measures — term coverage, title placement, density — and blind to what a
 * memory is *about*: a note titled "callback retries" does not match a query for
 * "webhook redelivery" no matter how many terms overlap.
 *
 * So this module adds the missing decision without removing the existing one:
 *
 * 1. Project each candidate into a bounded, redacted excerpt a *selector* can
 *    read — the whole body would cost more context than the recall saves.
 * 2. Let the composition supply a selector (the plugin wires a small model
 *    through the Host's fork seam); with none supplied, recall costs nothing
 *    and stays deterministic.
 * 3. **Validate the selector's answer rather than trusting it.** A selector is
 *    a model, and a model that names an id it was never shown, names one twice,
 *    or answers with a hundred ids is broken in a way the caller must be able to
 *    see. Every one of those cases is either dropped with a named reason or
 *    falls back to the lexical ordering with the reason recorded — never a
 *    silently shorter list.
 *
 * Three rules this module imposes on itself
 * ----------------------------------------
 * - **It never returns an id it was not given.** Recall output is joined back
 *   against the store by id, so an id that does not exist is a crash waiting for
 *   a later stage. Validation happens here, once.
 * - **An empty selector answer is data, not failure.** A selector that read five
 *   candidates and selected none is reporting that nothing was relevant; that is
 *   a real answer, so it is returned as one. Only a selector that *cannot be
 *   read* falls back.
 * - **The result never claims completeness.** `omitted` counts the candidates
 *   the ordering had no room for, so "3 memories" cannot be misread as "3 of the
 *   3 memories that exist".
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/memory/memory-recall
 */

import { lexicalRelevance, memoryQueryTokens } from '../engineering-memory.ts'
import { describeMemoryAge, type MemoryFreshness } from './memory-age.ts'
import { cutAtCodePointBoundary, sanitizeMemoryText } from './memory-security.ts'
import { redactCredentialShapes } from '../secret-scan.ts'

/** How many memories recall returns when the caller states no preference. */
export const DEFAULT_MEMORY_RECALL_LIMIT = 5
/**
 * Ceiling on one recall. Past a handful, a recalled memory stops being evidence
 * and starts being a context tax — the injected excerpt costs more than the
 * fact is worth.
 */
export const MAX_MEMORY_RECALL_LIMIT = 25
/** Characters of body handed to the selector, around the first query hit. */
export const MAX_MEMORY_EXCERPT_CHARS = 400
/** Characters of body before the first hit that the excerpt keeps for context. */
export const MEMORY_EXCERPT_LEAD_CHARS = 80
/**
 * Longest selector answer treated as an answer at all. A model that returns
 * thousands of ids has malfunctioned, and enumerating its output as per-id drop
 * records would turn one bad answer into an unbounded result.
 */
export const MAX_MEMORY_SELECTOR_ANSWER = 200

/** Which mechanism produced the returned ordering. */
export type MemoryRecallStrategy = 'selector' | 'lexical'

/** Why a candidate or a selector answer entry did not make the result. */
export type MemoryRecallDropReason =
  /** Two candidates shared an id; the first occurrence won. */
  | 'duplicate-candidate'
  /** The selector named an id it was not offered. */
  | 'unknown-id'
  /** The selector named the same id more than once; the first occurrence won. */
  | 'duplicate-selection'
  /** The selector named more ids than the limit allowed. */
  | 'over-limit'

export interface MemoryRecallDrop {
  readonly id: string
  readonly reason: MemoryRecallDropReason
}

/** One stored memory, as recall receives it. */
export interface MemoryRecallCandidate {
  readonly id: string
  readonly title: string
  readonly kind: string
  readonly trust: string
  readonly createdAt: number
  readonly body: string
}

/** What the selector actually reads: bounded, redacted, and dated. */
export interface MemoryRecallExcerpt {
  readonly id: string
  readonly title: string
  readonly kind: string
  readonly trust: string
  readonly freshness: MemoryFreshness
  /** A short duration such as `3 days`; the selector can weigh it. */
  readonly ageLabel: string
  readonly excerpt: string
}

/**
 * A selector names the candidate ids worth recalling, best first.
 *
 * It receives only excerpts, never the store: recall must not depend on a
 * collaborator having database access, and an excerpt is bounded by
 * construction. Returning an id outside `excerpts` is a contract violation the
 * caller records as {@link MemoryRecallDrop} rather than acting on.
 */
export type MemorySelector = (
  query: string,
  excerpts: readonly MemoryRecallExcerpt[],
  limit: number,
  signal: AbortSignal | undefined,
) => Promise<readonly string[]>

export interface MemoryRecallRequest {
  readonly query: string
  readonly candidates: readonly MemoryRecallCandidate[]
  /** Defaults to {@link DEFAULT_MEMORY_RECALL_LIMIT}; must be within bounds. */
  readonly limit?: number
  /** The clock the freshness labels are relative to. */
  readonly now: number
  readonly signal?: AbortSignal
}

export interface MemoryRecallResult {
  readonly strategy: MemoryRecallStrategy
  /** Selected ids, best first. Never more than `limit`, never an unknown id. */
  readonly ids: readonly string[]
  /** The excerpts for {@link ids}, in the same order. */
  readonly excerpts: readonly MemoryRecallExcerpt[]
  /**
   * Why the selector's answer could not be used, when one was tried. Absent when
   * the selector answered usably, and absent when no selector was supplied at
   * all — a deliberately lexical recall is not a failure.
   */
  readonly selectorFailure?: string
  readonly dropped: readonly MemoryRecallDrop[]
  /** Candidates the ordering had no room for. */
  readonly omitted: number
  /** True when the request arrived already aborted, so nothing was recalled. */
  readonly aborted: boolean
}

/**
 * Trust ordering for the lexical tiebreak. A reviewed record outranks a captured
 * one because a human signed off on it; superseded and rejected records sort last
 * even though they are still valid FTS hits.
 *
 * This is a *tiebreak*, not a filter: recall may still return a draft when the
 * query matches nothing else, which is why it is a ranked list rather than the
 * `USER_VISIBLE_TRUSTS` allowlist the user-facing surfaces use.
 */
const TRUST_RANK: Readonly<Record<string, number>> = {
  reviewed: 0,
  captured: 1,
  draft: 2,
  rejected: 3,
  superseded: 4,
}
/** Rank for a trust value this build does not know, so an upgrade cannot reorder nothing. */
const UNKNOWN_TRUST_RANK = 5

function trustRank(trust: string): number {
  return TRUST_RANK[trust] ?? UNKNOWN_TRUST_RANK
}

function requireLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_MEMORY_RECALL_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MEMORY_RECALL_LIMIT) {
    throw new Error(`memory recall limit must be an integer between 1 and ${MAX_MEMORY_RECALL_LIMIT}`)
  }
  return limit
}

/**
 * Whether a signal was asked to stop, evaluated at the moment of the call.
 *
 * This is a function rather than a property read because the TypeScript control
 * flow would otherwise narrow `signal.aborted` to false after the entry guard
 * and reject the later re-check as impossible — while the whole point of the
 * selector path is that `aborted` can become true *during* the await.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * The excerpt window: centred on the first query hit rather than taken from the
 * head.
 *
 * A memory's first sentence is often framing ("While investigating the billing
 * outage…") and its matched sentence is the fact. Slicing from the head would
 * hand the selector lead-in for every candidate and make a whole class of
 * memories indistinguishable.
 */
/**
 * The index in `text` of the character whose lowercased form starts at
 * `loweredIndex`.
 *
 * The search runs on a lowercased copy because matching must be case-insensitive,
 * but `toLowerCase()` does not preserve length (U+0130 lowercases to two code
 * units), so an offset taken there is not an offset into the original: enough of
 * those before the match and the window slides past the end of the text. The walk
 * is per code point because that is where the difference comes from — one
 * character can lower to several code units.
 */
function originalIndexForLowered(text: string, loweredIndex: number): number {
  let lowered = 0
  for (let index = 0; index < text.length;) {
    const character = String.fromCodePoint(text.codePointAt(index) as number)
    const width = character.toLowerCase().length
    if (lowered + width > loweredIndex) return index
    lowered += width
    index += character.length
  }
  return text.length
}

function excerptAround(body: string, tokens: readonly string[], maxChars: number): string {
  const text = sanitizeMemoryText(body)
  if (text.length <= maxChars) return text
  const haystack = text.toLowerCase()
  let loweredHit = -1
  for (const token of tokens) {
    const index = haystack.indexOf(token)
    if (index !== -1 && (loweredHit === -1 || index < loweredHit)) loweredHit = index
  }
  if (loweredHit === -1) return `${cutAtCodePointBoundary(text, maxChars)}…`
  const hit = originalIndexForLowered(text, loweredHit)
  // Both ends are snapped to a character boundary: the lead-in may start on the
  // second half of a surrogate pair, and the window may end on the first half.
  const snapped = Math.max(0, hit - MEMORY_EXCERPT_LEAD_CHARS)
  const trailing = text.charCodeAt(snapped)
  const start = trailing >= 0xdc00 && trailing <= 0xdfff ? snapped + 1 : snapped
  const window = cutAtCodePointBoundary(text.slice(start), maxChars)
  return `${start > 0 ? '…' : ''}${window}${start + window.length < text.length ? '…' : ''}`
}

function toExcerpt(candidate: MemoryRecallCandidate, tokens: readonly string[], now: number): MemoryRecallExcerpt {
  const age = describeMemoryAge(candidate.createdAt, now)
  return {
    id: candidate.id,
    title: sanitizeMemoryText(candidate.title, 200),
    kind: candidate.kind,
    trust: candidate.trust,
    freshness: age.freshness,
    ageLabel: age.label,
    excerpt: excerptAround(candidate.body, tokens, MAX_MEMORY_EXCERPT_CHARS),
  }
}

/**
 * Deduplicate candidates by id, keeping the first occurrence.
 *
 * Recall reaches here from an FTS result joined to a body fetch, so a repeated id
 * means an upstream join fanned out. Collapsing it here keeps a duplicated row
 * from consuming two of the `limit` slots.
 */
function uniqueCandidates(candidates: readonly MemoryRecallCandidate[]): {
  readonly unique: readonly MemoryRecallCandidate[]
  readonly dropped: readonly MemoryRecallDrop[]
} {
  const seen = new Set<string>()
  const unique: MemoryRecallCandidate[] = []
  const dropped: MemoryRecallDrop[] = []
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) {
      dropped.push({ id: candidate.id, reason: 'duplicate-candidate' })
      continue
    }
    seen.add(candidate.id)
    unique.push(candidate)
  }
  return { unique, dropped }
}

/**
 * The deterministic ordering: relevance first, then trust, then recency, then id.
 *
 * Lexical relevance and trust answer different questions — "does this match" and
 * "should this be believed" — so they are separate sort keys rather than one
 * blended score. Blending would let a high-trust irrelevant record outrank a
 * relevant draft, which is the failure mode a user notices first.
 *
 * The trailing id comparison is not decoration: it makes the order total, so the
 * same store produces the same recall on every call and a test can assert an
 * exact sequence instead of a set.
 */
function lexicalOrdering(candidates: readonly MemoryRecallCandidate[], tokens: readonly string[]): readonly MemoryRecallCandidate[] {
  return [...candidates].sort((left, right) => {
    const leftScore = lexicalRelevance(tokens, left.title, left.body)
    const rightScore = lexicalRelevance(tokens, right.title, right.body)
    if (leftScore !== rightScore) return rightScore - leftScore
    const leftRank = trustRank(left.trust)
    const rightRank = trustRank(right.trust)
    if (leftRank !== rightRank) return leftRank - rightRank
    if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt
    return left.id.localeCompare(right.id)
  })
}

/**
 * Validate and bound one selector answer.
 *
 * `undefined` means the answer is unusable and the caller must fall back, with
 * the returned reason explaining why. An empty array is a usable answer.
 */
function readSelectorAnswer(
  answer: unknown,
  offered: ReadonlySet<string>,
  limit: number,
): { readonly ids: readonly string[]; readonly dropped: readonly MemoryRecallDrop[] } | { readonly failure: string } {
  if (!Array.isArray(answer)) return { failure: 'the selector did not return an array of ids' }
  if (answer.length > MAX_MEMORY_SELECTOR_ANSWER) {
    return { failure: `the selector returned ${answer.length} ids, more than the ${MAX_MEMORY_SELECTOR_ANSWER} a recall accepts` }
  }
  const ids: string[] = []
  const dropped: MemoryRecallDrop[] = []
  const seen = new Set<string>()
  for (const entry of answer) {
    // One non-string makes the whole answer unreadable: partial acceptance would
    // silently decide which half of a malformed answer was meant.
    if (typeof entry !== 'string') return { failure: 'the selector returned an id that was not a string' }
    if (!offered.has(entry)) {
      dropped.push({ id: entry, reason: 'unknown-id' })
      continue
    }
    if (seen.has(entry)) {
      dropped.push({ id: entry, reason: 'duplicate-selection' })
      continue
    }
    seen.add(entry)
    if (ids.length >= limit) {
      dropped.push({ id: entry, reason: 'over-limit' })
      continue
    }
    ids.push(entry)
  }
  // A selector that named only ids it was never shown produced no signal at all;
  // its silence is not a decision, so the lexical ordering answers instead.
  if (ids.length === 0 && dropped.length > 0) {
    return { failure: 'the selector named nothing it was offered' }
  }
  return { ids, dropped }
}

/**
 * Recall the memories worth injecting for one query.
 *
 * Never throws for a selector's sake: an absent selector, a throwing one, and a
 * malformed answer all resolve to the lexical ordering with the reason recorded.
 * It *does* throw for a malformed request (an out-of-range limit), because that is
 * a caller bug whose silent clamp would hide a mis-sized context budget.
 */
export async function selectMemories(
  request: MemoryRecallRequest,
  selector?: MemorySelector,
): Promise<MemoryRecallResult> {
  const limit = requireLimit(request.limit)
  const tokens = memoryQueryTokens(request.query)
  const { unique, dropped: candidateDrops } = uniqueCandidates(request.candidates)
  const excerpts = unique.map(candidate => toExcerpt(candidate, tokens, request.now))
  // Excerpts are built in candidate order, so one index-aligned lookup serves both
  // answer paths without re-scanning the candidate list per selected id.
  const excerptById = new Map(unique.map((candidate, index) => [candidate.id, excerpts[index]!]))
  const ordered = lexicalOrdering(unique, tokens).slice(0, limit)
  const fallback = {
    ids: ordered.map(candidate => candidate.id),
    excerpts: ordered.map(candidate => excerptById.get(candidate.id)!),
    omitted: unique.length - ordered.length,
  }

  // An aborted recall ran no selector and chose nothing, and says so. Returning a
  // lexical list here would answer a question the caller withdrew.
  if (isAborted(request.signal)) {
    return { strategy: 'lexical', ids: [], excerpts: [], dropped: candidateDrops, omitted: unique.length, aborted: true }
  }

  if (selector !== undefined) {
    let answer: unknown
    try {
      answer = await selector(request.query, excerpts, limit, request.signal)
    } catch (error) {
      // The signal is checked after the catch, not before the call: a selector
      // rejects *because* the caller aborted, and reporting that as "the selector
      // failed" would blame a collaborator for the caller's own decision.
      //
      // The selector is a model call, so its rejection can quote the request it
      // sent — including the credential it authenticated with. The reason is
      // returned to the caller and read back as a diagnosis, so it is masked
      // before it leaves this function.
      const reason = isAborted(request.signal)
        ? 'the recall was aborted'
        : `the selector failed: ${redactCredentialShapes(error instanceof Error ? error.message : String(error))}`
      return { strategy: 'lexical', ...fallback, selectorFailure: reason, dropped: candidateDrops, aborted: false }
    }
    const read = readSelectorAnswer(answer, new Set(unique.map(candidate => candidate.id)), limit)
    if ('failure' in read) {
      return { strategy: 'lexical', ...fallback, selectorFailure: read.failure, dropped: candidateDrops, aborted: false }
    }
    return {
      strategy: 'selector',
      ids: read.ids,
      excerpts: read.ids.map(id => excerptById.get(id)!),
      dropped: [...candidateDrops, ...read.dropped],
      omitted: unique.length - read.ids.length,
      aborted: false,
    }
  }

  return { strategy: 'lexical', ...fallback, dropped: candidateDrops, aborted: false }
}
