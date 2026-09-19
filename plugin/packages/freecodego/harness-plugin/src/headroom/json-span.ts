/**
 * Locating the JSON container inside a wrapped tool payload.
 *
 * Why this is its own module
 * --------------------------
 * Two headroom modules need the same reading of the same bytes, and they grew
 * two copies of it. `content-detector.ts` decides whether a payload *is* JSON —
 * which is what routes it to the crusher — and `smart-crusher.ts` then has to
 * find that same container to compact it; both also have to read the
 * whitespace-separated `{...} {...}` form some web-search backends emit
 * (#1741). The span finder, the concatenated-object decoder and the bulk
 * fraction were duplicated character for character, and a duplicated shape
 * drifts the first time either copy is corrected. The symptom would be the worst
 * kind: the detector claims `json` and the crusher does not recognise the
 * payload (or the reverse), so the work is done and thrown away, and the routing
 * looks nondeterministic.
 *
 * `findJsonSpan` is string- and escape-aware, so a brace inside a JSON string
 * does not close the span. `decodeConcatenatedObjects` requires *every* top-level
 * value in the run to be an object, because the callers use this to recognise a
 * document made of objects rather than to salvage one object out of prose.
 * `findBulkJsonSpan` is the same reading applied to a body that sits behind a
 * wrapper line, and it is what keeps the detector and the crusher from answering
 * differently when that wrapper contains a bracketed word.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/headroom/json-span
 */

import type { JsonValue } from '../types.ts'

/** One decoded JSON object. Declared here rather than imported from the crusher,
 * which needs the same shape and would make this module depend on the module
 * that depends on it. */
export type JsonObject = { readonly [key: string]: JsonValue }

/** A decoded JSON value must be at least this fraction of the wrapped content. */
export const JSON_MIN_BULK_FRACTION = 0.6

/** Locate the balanced JSON container span starting at or after `from` (string/escape aware). */
export function findJsonSpan(text: string, from = 0): readonly [number, number] | undefined {
  let start = -1
  for (let i = from; i < text.length; i += 1) {
    const c = text[i]
    if (c === '{' || c === '[') {
      start = i
      break
    }
  }
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{' || c === '[') depth += 1
    else if (c === '}' || c === ']') {
      depth -= 1
      if (depth === 0) return [start, i + 1]
    }
  }
  return undefined
}

/**
 * The bulk JSON container embedded in a wrapped payload: the first span that both
 * parses and covers at least `minFraction` of the content.
 *
 * Scanning must not stop at the payload's first bracket. A bracketed word in a
 * preceding log or prose line — `[WARN]`, `[deprecated]`, `{1}` — is balanced and
 * therefore looks like a container span, so stopping there made one status word
 * decide the answer for the whole payload: the detector reported `log` (the
 * warning line matches log patterns) and the JSON body, which is 90+% of the
 * bytes and carried a ready 50% saving, reached the model verbatim. A candidate
 * is only skipped once it has failed the bulk test or `JSON.parse`, and the scan
 * resumes after it.
 *
 * An *unbalanced* first bracket still decides the answer, deliberately: chasing
 * every later bracket would re-scan the tail per candidate (quadratic on
 * pathological payloads) to salvage a shape the callers can already read another
 * way.
 */
export function findBulkJsonSpan(text: string, minFraction = JSON_MIN_BULK_FRACTION): { readonly span: readonly [number, number]; readonly value: JsonValue } | undefined {
  const bulk = text.trim().length * minFraction
  let from = 0
  while (from < text.length) {
    const span = findJsonSpan(text, from)
    if (span === undefined) return undefined
    const [start, end] = span
    if (end - start >= bulk) {
      try {
        return { span, value: JSON.parse(text.slice(start, end)) as JsonValue }
      } catch {
        // A balanced span that is not JSON (prose's `[WARN]`, `{1}`): keep looking.
      }
    }
    from = end
  }
  return undefined
}

/** Decode a run of whitespace-separated top-level JSON objects (`{...} {...}`). */
export function decodeConcatenatedObjects(stripped: string): readonly JsonObject[] | undefined {
  const items: JsonObject[] = []
  let pos = 0
  while (pos < stripped.length) {
    while (pos < stripped.length && /\s/.test(stripped[pos]!)) pos += 1
    if (pos >= stripped.length) break
    if (stripped[pos] !== '{') return undefined
    const span = findJsonSpan(stripped, pos)
    if (span === undefined || span[0] !== pos) return undefined
    try {
      const value = JSON.parse(stripped.slice(span[0], span[1])) as unknown
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
      items.push(value as JsonObject)
    } catch {
      return undefined
    }
    pos = span[1]
  }
  return items.length >= 2 ? items : undefined
}
