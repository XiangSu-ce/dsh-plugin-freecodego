/**
 * Did a compaction's summary quote the history it replaced, or invent it?
 *
 * Why
 * ---
 * A compaction summary is written by a model, and the history it replaces is
 * deleted in the same commit. That makes it the one artifact in the session that
 * cannot be checked later by looking at its source — so if the summary says a
 * command printed `EBADENGINE`, and it did not, nothing downstream will ever
 * disagree. `rehydration.ts` puts standing context back after a compaction; it
 * does not ask whether the summary was faithful.
 *
 * This module asks, at the only moment the question is still answerable: the
 * archive is gone afterwards. Two things are checked, and the difference between
 * them is the whole design:
 *
 * - **A quotation is a claim of verbatim reproduction.** A fenced block, or a
 *   quoted span long enough that it cannot be emphasis
 *   ({@link CompactionFidelityOptions.minQuoteChars}), has to appear in the
 *   archive. One miss rejects the summary, because a fabricated code block is
 *   not offset by a good average — a summary is either quoting the record or it
 *   is not.
 * - **A path reference is a claim of existence.** A summary that cites
 *   `src/never/existed.ts` is describing work that did not happen. Scored, not
 *   absolute: a reference can legitimately name a path the archive mentions only
 *   by directory, and one such case should not condemn a summary.
 *
 * Whitespace is the one tolerated difference: a summariser reflows a long line
 * and adds a space after a colon the archive wrote without one, and neither is a
 * misquote. Nothing else is normalized — case and backslashes are preserved,
 * because each can change what the quoted text means.
 *
 * An empty result is `accepted`, deliberately: a summary that quotes nothing and
 * cites nothing makes no fidelity claim, so there is nothing here to falsify.
 * Its accuracy is a different question from its faithfulness, and this module
 * does not pretend to answer that one. What it refuses to do is stay silent when
 * the summary *did* claim fidelity and the claim is false.
 *
 * @module @deepseek-ai/dsh-freecodego/harness-plugin/compaction-fidelity
 */

/** The tunables, so a caller can loosen a threshold without editing the rules. */
export interface CompactionFidelityOptions {
  /**
   * Shortest quoted span treated as a verbatim claim (default 24).
   *
   * Below this a quote is emphasis — a summary that writes `it said "no"` is not
   * claiming the archive contains no. Above it, the span is long enough that
   * reproducing it is the point.
   */
  readonly minQuoteChars?: number
  /** Fraction of path references that must exist in the archive (default 0.8). */
  readonly minReferenceHitRate?: number
}

/** Why one element of the summary could not be verified. */
export type CompactionFidelityMissKind = 'quote-not-in-archive' | 'reference-not-in-archive' | 'empty-archive'

/** One unverifiable element, with the text so a reader can judge it directly. */
export interface CompactionFidelityMiss {
  readonly kind: CompactionFidelityMissKind
  /** The quotation or reference as the summary wrote it, bounded for a log line. */
  readonly text: string
  readonly reason: string
}

/** The audit's answer. */
export interface CompactionFidelityVerdict {
  /**
   * Whether the summary may replace the history it was written from.
   *
   * False when any quotation is unverifiable, when the archive is empty while the
   * summary quotes something, or when too many references are unaccounted for.
   */
  readonly accepted: boolean
  readonly quotesChecked: number
  readonly quotesVerified: number
  readonly referencesChecked: number
  readonly referencesVerified: number
  readonly misses: readonly CompactionFidelityMiss[]
  /** One sentence, so the outcome never has to be inferred from the counts. */
  readonly note: string
}

const DEFAULT_MIN_QUOTE_CHARS = 24
const DEFAULT_MIN_REFERENCE_HIT_RATE = 0.8
/** Longest offending text kept in a miss, so one huge block cannot flood a log. */
const MAX_MISS_TEXT = 200

/** Fenced blocks, which are quoted verbatim output or code by construction. */
const FENCE = /```[^\n]*\n([\s\S]*?)```/gu
/**
 * Long quotations in the marks a summary actually uses, at the given length.
 *
 * Built from the threshold rather than written with 24 in the pattern, because a
 * literal bound is one {@link CompactionFidelityOptions.minQuoteChars} cannot
 * move: a caller asking for shorter quotations to count would find the option
 * silently ignored, and the count it reads back would be the default's.
 */
function quotePatterns(minQuoteChars: number): readonly RegExp[] {
  // The caller's bound is already a whole, positive number of characters by the time
  // it reaches this string — see {@link thresholdsFrom}. It has to be, because a
  // repetition count is *syntax*: `{30.5,}` is not a valid one and `new RegExp`
  // throws on it in unicode mode, so an unnormalized bound fails here, mid-audit,
  // rather than at the call that supplied it.
  const atLeast = `{${String(minQuoteChars)},}`
  return [
    new RegExp(`"([^"\\n]${atLeast})"`, 'gu'),
    new RegExp(`'([^'\\n]${atLeast})'`, 'gu'),
    new RegExp(`“([^”\\n]${atLeast})”`, 'gu'),
    new RegExp(`「([^」\\n]${atLeast})」`, 'gu'),
  ]
}
/**
 * Path references: something with a separator and an extension, or a
 * `file:line` pair. Bare words are deliberately not matched — `compactSurfaceRegion`
 * is an identifier, not a citation, and demanding it appear in the archive would
 * reject correct summaries of code the archive names differently.
 */
const REFERENCES: readonly RegExp[] = [
  /[\w.-]+(?:[\\/][\w.-]+)+\.\w{1,6}/gu,
  /[\w.-]+\.\w{1,6}:\d+/gu,
]

/**
 * Strip every whitespace character, for the tolerant quotation comparison.
 *
 * Removing rather than collapsing, because a prose summariser both reflows a
 * long line *and* adds a space after a colon that the archive did not have; a
 * collapse-only rule rejects that faithful quotation, and a check that rejects
 * faithful summaries is one the caller turns off.
 *
 * The risk is stated rather than hidden: an invented quotation whose characters
 * match the archive with different spacing passes. That direction is chosen
 * deliberately, because the two errors are not equal here — a false accept
 * leaves a plausible summary in place, while a false reject throws away a real
 * compaction and pays for the summarisation twice.
 */
function stripWhitespace(value: string): string {
  return value.replace(/\s+/gu, '')
}

/** The archive as one searchable body plus its whitespace-free counterpart. */
function archiveBodies(archive: readonly string[]): { readonly raw: string; readonly dense: string } {
  const joined = archive.join('\n')
  return { raw: joined, dense: stripWhitespace(joined) }
}

/** Whether a quotation appears in the archive, verbatim or ignoring spacing. */
function quoteIsPresent(quote: string, bodies: { readonly raw: string; readonly dense: string }): boolean {
  if (bodies.raw.includes(quote)) return true
  const dense = stripWhitespace(quote)
  return dense !== '' && bodies.dense.includes(dense)
}

/** The path part of a reference, without a trailing `:line`. */
function referencePath(reference: string): string {
  return reference.replace(/:\d+$/u, '')
}

/** Depth and size bounds on {@link archiveTextFrom}. */
const ARCHIVE_MAX_DEPTH = 8
const ARCHIVE_MAX_CHARS = 2_000_000

/**
 * The strings one replaced event contributes to the archive.
 *
 * The archive has to be the *text* the session held, not its JSON: a summary
 * quoting a multi-line block reproduces real newlines, while `JSON.stringify`
 * would hand this module the two characters `\` and `n`, so a faithful quotation
 * would be reported as invented. Every string value is therefore collected as it
 * stands, whichever field it sits in, because which field carries a message's
 * text is the session's business rather than this check's.
 *
 * Bounded in both directions: a depth cap stops a pathological event graph, and a
 * character cap stops one enormous tool result from making the comparison
 * quadratic for the rest of the audit.
 *
 * @param value - one replaced event's `data`.
 * @returns the strings it carries, in encounter order.
 */
export function archiveTextFrom(value: unknown): readonly string[] {
  const collected: string[] = []
  let chars = 0
  const walk = (node: unknown, depth: number): void => {
    if (depth > ARCHIVE_MAX_DEPTH || chars >= ARCHIVE_MAX_CHARS) return
    if (typeof node === 'string') {
      if (node !== '') {
        collected.push(node)
        chars += node.length
      }
      return
    }
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, depth + 1)
      return
    }
    if (node !== null && typeof node === 'object') {
      for (const entry of Object.values(node as Record<string, unknown>)) walk(entry, depth + 1)
    }
  }
  walk(value, 0)
  return collected
}

/**
 * The two thresholds, normalized once so no caller value reaches a pattern or a
 * comparison the way it arrived.
 *
 * Both are step functions of a number, and both have a value that is *not* a number
 * of anything: a bound that is fractional, negative, or not finite. Each used to be
 * handled by arithmetic that quietly kept it — `Math.max(1, 30.5)` is still 30.5 -
 * and the two failures were opposite and both silent from the caller's side. A
 * fractional quote bound threw out of `new RegExp`, taking the compaction with it; a
 * NaN reference rate made every `>=` false, rejecting a summary that cites nothing
 * while the returned note said there was nothing to check.
 *
 * The quote bound rounds *up*. The two directions are not equal here: a bound that
 * ends up lower than the caller's catches more quotations, and this module's whole
 * stance is that a false reject costs a real compaction, so a caller's bound is
 * never lowered. The rate is clamped to `[0, 1]`, where both ends are meaningful by
 * construction: `0` accepts anything, `1` demands that every cited path exists.
 * @param options - the caller's thresholds, if any.
 * @returns both thresholds as numbers this module can use.
 */
function thresholdsFrom(options: CompactionFidelityOptions): { readonly minQuoteChars: number; readonly minReferenceHitRate: number } {
  const quoteChars = options.minQuoteChars
  const rate = options.minReferenceHitRate
  return {
    minQuoteChars: typeof quoteChars === 'number' && Number.isFinite(quoteChars) ? Math.max(1, Math.ceil(quoteChars)) : DEFAULT_MIN_QUOTE_CHARS,
    minReferenceHitRate: typeof rate === 'number' && Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : DEFAULT_MIN_REFERENCE_HIT_RATE,
  }
}

/**
 * Audit one compaction summary against the history it replaced.
 *
 * @param input - the summary text and the archived message bodies it replaced.
 * @param options - the two thresholds, when the defaults do not fit.
 * @returns the verdict, the counts it rests on, and every miss.
 */
export function auditCompactionFidelity(
  input: { readonly summary: string; readonly archive: readonly string[] },
  options: CompactionFidelityOptions = {},
): CompactionFidelityVerdict {
  const { minQuoteChars, minReferenceHitRate } = thresholdsFrom(options)
  // Fences are removed from the text the quote patterns read, so a fence's own
  // quotation marks cannot be counted a second time as a separate claim.
  const fenced: string[] = []
  const prose = input.summary.replace(FENCE, (_match, body: string) => {
    fenced.push(body)
    return '\n'
  })
  const quotes = [...fenced]
  for (const pattern of quotePatterns(minQuoteChars)) {
    for (const match of prose.matchAll(pattern)) {
      const captured = match[1]
      if (captured !== undefined && captured.length >= minQuoteChars) quotes.push(captured)
    }
  }
  const references = new Set<string>()
  for (const pattern of REFERENCES) {
    for (const match of input.summary.matchAll(pattern)) references.add(match[0])
  }
  const bodies = archiveBodies(input.archive)
  const misses: CompactionFidelityMiss[] = []
  let quotesVerified = 0
  for (const quote of quotes) {
    if (quoteIsPresent(quote, bodies)) {
      quotesVerified += 1
      continue
    }
    misses.push({
      kind: input.archive.length === 0 ? 'empty-archive' : 'quote-not-in-archive',
      text: quote.slice(0, MAX_MISS_TEXT),
      reason: input.archive.length === 0
        ? 'the summary quotes text but no archive was supplied to check it against'
        : 'this quotation does not appear in the history the summary replaced',
    })
  }
  let referencesVerified = 0
  for (const reference of references) {
    if (bodies.raw.includes(referencePath(reference))) {
      referencesVerified += 1
      continue
    }
    misses.push({
      kind: 'reference-not-in-archive',
      text: reference.slice(0, MAX_MISS_TEXT),
      reason: 'this path is named by the summary but does not appear anywhere in the history it replaced',
    })
  }
  const referenceHitRate = references.size === 0 ? 1 : referencesVerified / references.size
  const nothingToCheck = quotes.length === 0 && references.size === 0
  const quoteMisses = misses.filter(miss => miss.kind !== 'reference-not-in-archive')
  const accepted = quoteMisses.length === 0 && referenceHitRate >= minReferenceHitRate
  return {
    accepted,
    quotesChecked: quotes.length,
    quotesVerified,
    referencesChecked: references.size,
    referencesVerified,
    misses,
    note: nothingToCheck
      ? 'No verbatim claim to check: the summary quotes no span and cites no path, so faithfulness is not the question here.'
      : accepted
        ? `Every quoted span appears in the replaced history, and ${referencesVerified} of ${references.size} path reference(s) do.`
        : `${quoteMisses.length} quotation(s) could not be found in the replaced history${referenceHitRate < minReferenceHitRate ? `, and only ${referencesVerified} of ${references.size} path reference(s) do` : ''}.`,
  }
}
