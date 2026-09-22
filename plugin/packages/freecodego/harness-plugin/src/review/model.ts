/**
 * The model port every review stage is written against, and the JSON reader its
 * structured stages share.
 *
 * Why a port and not a provider call
 * ----------------------------------
 * The review pipeline runs three *bounded* model stages (grouping, risk planning,
 * post-filtering) and one agentic stage (per-file review). Writing all four
 * against a two-method interface means the pipeline is exercised end to end
 * without a provider — a run's coverage accounting, budget arithmetic, or
 * relocation behaviour can be tested with a fixture that returns a fixed string.
 * The provider wiring belongs to the plugin's adapter layer, where it already
 * exists for every other model call.
 *
 * Why token counts are part of the result
 * ---------------------------------------
 * The budget is enforced against what a call actually spent, not against what it
 * was asked to spend, so a stage cannot report success while its cost goes
 * unrecorded. A port that returned only text would make the budget advisory.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/review/model
 */

import { tokensFromChars } from '../token-estimate.ts'

/** One bounded model request. */
export interface ReviewModelRequest {
  readonly system: string
  readonly user: string
  /** Output ceiling for this call; the caller decides, so a cheap stage stays cheap. */
  readonly maxOutputTokens?: number
  readonly signal?: AbortSignal
}

/** One bounded model response with its metered cost. */
export interface ReviewModelResult {
  readonly text: string
  readonly inputTokens: number
  readonly outputTokens: number
}

/** The model surface the review stages use. */
export interface ReviewModelPort {
  /**
   * Run one request.
   *
   * A missing route or a provider failure rejects; a caller distinguishes that
   * from an empty answer rather than treating both as "nothing found".
   */
  generate(request: ReviewModelRequest): Promise<ReviewModelResult>
}

/**
 * Read the first JSON object or array out of a model response.
 *
 * Tolerant on purpose. A model that wraps its answer in a fenced block, prefixes
 * it with "Here is the JSON", or appends a closing remark has still answered
 * correctly, and a stage that fails on that is a stage that fails intermittently
 * for reasons unrelated to its job. What is *not* tolerated is inventing an
 * answer: when no balanced value is found, the result is undefined and the
 * caller decides whether the stage can proceed without it.
 */
export function extractJsonValue(text: string): unknown {
  const fenced = firstBalanced(text)
  if (fenced === undefined) return undefined
  try {
    return JSON.parse(fenced)
  } catch {
    return undefined
  }
}

/**
 * Scan for the first balanced `{...}` or `[...]` span.
 *
 * Tracking depth and string state is what makes a brace inside a string literal
 * — a diff hunk, a JSON snippet inside a comment — not terminate the span early.
 */
function firstBalanced(text: string): string | undefined {
  const start = firstIndexOfAny(text, ['{', '['])
  if (start === -1) return undefined
  const open = text[start] as string
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < text.length; index += 1) {
    const char = text[index] as string
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return undefined
}

/** Index of the earliest occurrence of any of `needles`, or -1. */
function firstIndexOfAny(text: string, needles: readonly string[]): number {
  let best = -1
  for (const needle of needles) {
    const at = text.indexOf(needle)
    if (at === -1) continue
    if (best === -1 || at < best) best = at
  }
  return best
}

/**
 * Approximate a token count from text, for the budget when a provider does not report one.
 *
 * Delegates to the plugin's single density rather than dividing by four here: two
 * divisors is how the number this budget is measured against drifts from the one
 * the host prices with, and the drift shows up as a budget that admits or refuses
 * the wrong run. `token-estimate.spec.ts` enforces the single source by grep.
 * @param text - the text to measure.
 * @returns the approximate token count.
 */
export function approximateTokens(text: string): number {
  return tokensFromChars(text.length)
}

/** A model result that reports nothing, for a stage that could not be run. */
export function emptyModelResult(): ReviewModelResult {
  return { text: '', inputTokens: 0, outputTokens: 0 }
}
