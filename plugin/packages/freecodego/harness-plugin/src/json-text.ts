/**
 * JSON objects embedded in model prose.
 *
 * Why this exists
 * ---------------
 * Two modules ask a model for a JSON object and read it back out of the answer:
 * the action reviewer (`{verdict, rationale}`) and the Advisor (`{severity, note}`).
 * Both grew the same extraction, and the same one is wrong:
 *
 * ```ts
 * /\{[\s\S]*\}/.exec(text)
 * ```
 *
 * That is greedy, so it runs from the **first** `{` to the **last** `}` in the
 * entire answer. A model is free to add a sentence, and its sentence may contain
 * a brace — usually by quoting something it read in the transcript it was asked
 * to judge, which is untrusted text a hostile workspace controls. The captured
 * span is then not JSON at all:
 *
 * ```
 * {"verdict":"allow","rationale":"read-only"}
 *
 * I ignored the {"note":"example"} left in the transcript.
 * ```
 *
 * `JSON.parse` on that span throws `SyntaxError: Unexpected non-whitespace
 * character after JSON`, so a verdict the model *did* produce is thrown away and
 * the call falls back to prompting the user. That is the failure this module
 * removes, and it is worth naming precisely: the reviewer's own success was being
 * reported as `reviewer-failed`.
 *
 * How it reads instead
 * --------------------
 * Every `{` is a candidate start, and for each one the candidate ends are tried in
 * order until a span parses. That is deliberately *not* a string-aware brace
 * counter: a counter has to decide whether a quotation mark opens a string, and
 * prose is full of quotation marks that do not (`He said "no`. would leave the
 * counter inside a string for the rest of the answer). Eager parsing needs no such
 * guess — a wrong span simply fails to parse and the next one is tried, and a
 * brace inside a string is handled for free.
 *
 * The cost is bounded and acceptable for the inputs here: the answers are capped
 * to a few thousand characters by their own callers, and only the delimiter
 * positions are ever parsed. A huge answer is not a case this has to serve — the
 * action reviewer refuses a truncated verdict outright.
 *
 * Arrays too
 * ----------
 * The two memory modules that ask a model for a list of ids
 * (`memory/memory-selector.ts`, `memory/memory-dream-model.ts`) had the same
 * greedy span in the array spelling — `/\[[\s\S]*\]/`, first `[` to last `]` —
 * and therefore the same failure: a bracketed word in the sentence around the
 * array was swallowed into the span, the parse failed, and a selection the model
 * did produce was discarded. {@link jsonArraysIn} serves them from the one walk
 * {@link jsonObjectsIn} already uses.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/json-text
 */

/** Parse one candidate span as a JSON object, or `undefined` for anything else. */
function asObject(span: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(span)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/** Parse one candidate span as a JSON array, or `undefined` for anything else. */
function asArray(span: string): readonly unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(span)
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Every span of `text` delimited by `open`/`close` that `parse` accepts, in order
 * of appearance.
 *
 * One walk serves both JSON shapes because the two failures are the same failure:
 * a greedy span runs from the first opener to the last closer, so a delimiter in
 * the prose around the value ends up inside it. Eager parsing needs no
 * string-aware delimiter counter — a delimiter inside a quoted string is handled
 * for free, because a wrong span simply fails to parse.
 */
function jsonValuesIn<T>(text: string, open: string, close: string, parse: (span: string) => T | undefined): readonly T[] {
  const found: T[] = []
  for (let start = text.indexOf(open); start !== -1; start = text.indexOf(open, start + 1)) {
    for (let end = text.indexOf(close, start); end !== -1; end = text.indexOf(close, end + 1)) {
      const parsed = parse(text.slice(start, end + 1))
      if (parsed !== undefined) {
        found.push(parsed)
        // The earliest end that parses is the shortest value at this start: a
        // longer span from the same opener could only be a superset that this
        // function is not looking for.
        break
      }
    }
  }
  return found
}

/**
 * Every JSON object embedded in `text`, in order of appearance.
 *
 * An object nested inside another is reported as its own entry too (its `{` is a
 * start position like any other), which is what makes a caller that wants "the
 * first object with a usable field" work when the outer one is a wrapper.
 *
 * @param text - model output, or any text that may contain JSON.
 * @returns the parsed objects, outer-first at the same start position.
 */
export function jsonObjectsIn(text: string): readonly Record<string, unknown>[] {
  return jsonValuesIn(text, '{', '}', asObject)
}

/**
 * Every JSON array embedded in `text`, in order of appearance.
 *
 * The array spelling of {@link jsonObjectsIn}, for the two memory modules that ask
 * a model for a list of ids rather than a verdict object. A caller that wants "the
 * array the model meant" takes the first entry: an unparseable bracketed word is
 * skipped rather than swallowing the array into its span.
 *
 * An array nested inside another is reported as its own entry too, matching the
 * object walk.
 *
 * @param text - model output, or any text that may contain JSON.
 * @returns the parsed arrays, outer-first at the same start position.
 */
export function jsonArraysIn(text: string): readonly (readonly unknown[])[] {
  return jsonValuesIn(text, '[', ']', asArray)
}
