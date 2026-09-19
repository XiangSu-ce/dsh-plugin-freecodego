/**
 * Deterministic JSON text, for hashing.
 *
 * Why this exists
 * ---------------
 * Two modules in this plugin independently grew a `stableStringify`: request-shape
 * fingerprints tool schemas for cache-break attribution, and the doom-loop guard
 * fingerprints tool-call arguments. Both need the same property — *the same value
 * must always produce the same bytes* — and both were maintaining it by hand, in
 * two slightly different ways. The drift was real: one sorted with
 * `localeCompare` and the other with `<`, so the two "stable" encoders did not
 * agree with each other.
 *
 * `localeCompare` is the one that had to go. It is locale- and ICU-dependent, so
 * a fingerprint computed on a machine with a different collation could differ
 * from one computed here for byte-identical input — precisely the kind of
 * difference a fingerprint exists to rule out. Code-point ordering is total,
 * locale-independent and stable across runtimes, which is what a hash input
 * needs. It also happens to sort the same way for the ASCII keys that dominate
 * tool schemas, so no existing fingerprint moved.
 *
 * Contract
 * --------
 * - Object keys are sorted by code point, so insertion order never shows.
 * - `undefined` **properties are dropped**, matching `JSON.stringify`. A schema
 *   gaining `parameters: undefined` is not a change.
 * - A non-object runs through `JSON.stringify`; the JSON-invisible values
 *   (`undefined`, functions, symbols) fall back to the literal `null`, which is
 *   the encoding `JSON.stringify` gives them inside an array.
 *
 * Cycle handling is the one place the two callers genuinely disagree, so the
 * policy is explicit rather than shared:
 *
 * - {@link stableJson} is **cycle-tolerant**: a value already on the current
 *   path encodes as `null`. Use it on inputs that must never throw — the
 *   doom-loop guard runs inside a tool-execution hook, where an exception would
 *   break the call rather than deny it.
 * - {@link stableJsonStrict} **throws a labelled error** on a cycle. Use it where
 *   the caller can afford to lose the fingerprint for the turn and prefers a
 *   message over a silently-degraded hash (request-shape wraps it in a try/catch
 *   and reports "no fingerprint this turn").
 *
 * `ancestors` is a path set rather than a global seen set, so a value that merely
 * repeats a sub-object in two sibling positions still encodes normally; only a
 * value reachable from itself is a cycle.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/stable-json
 */

/** Literal both encoders substitute for a value JSON cannot represent. */
const JSON_NULL = 'null'

/**
 * Serialize `value` deterministically, tolerating reference cycles.
 *
 * @param value - any value; object graphs and repeated references are fine.
 * @returns Canonical JSON text that depends only on the value's content.
 */
export function stableJson(value: unknown): string {
  return walk(value, new Set(), () => JSON_NULL)
}

/**
 * Serialize `value` deterministically, refusing a reference cycle.
 *
 * @param value - any value; must not contain a cycle.
 * @returns Canonical JSON text that depends only on the value's content.
 * @throws Error when a value is reachable from itself. The message is labelled
 *   with the module name so a caught failure identifies its source.
 */
export function stableJsonStrict(value: unknown): string {
  return walk(value, new Set(), () => {
    throw new Error('stable-json: value contains a reference cycle, so it cannot be fingerprinted')
  })
}

/**
 * The one walker both encoders share.
 *
 * @param value - the current value.
 * @param ancestors - objects on the path from the root; mutated and restored.
 * @param onCycle - what to do when `value` is already on the path: return the
 *   substitute text, or throw.
 * @returns Canonical JSON text for `value`.
 */
function walk(value: unknown, ancestors: Set<object>, onCycle: () => string): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? JSON_NULL
  if (ancestors.has(value)) return onCycle()
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      // Read by index rather than with `map`, because `map` skips holes: a slot
      // with no value of its own left the output as `[,1]` — text that is not JSON
      // at all, produced by the one function whose contract is that a value always
      // encodes to the same bytes. JSON renders a hole as `null` (an explicit
      // `undefined` slot reaches the primitive branch above and lands on `null` for
      // the same reason), so reading every index is what makes the two agree.
      const parts: string[] = []
      for (let index = 0; index < value.length; index += 1) parts.push(walk(value[index], ancestors, onCycle))
      return `[${parts.join(',')}]`
    }
    // Two-way comparator, not three-way: `Object.entries` yields each key at most
    // once, so the equal case is unreachable and comparing it would be dead code.
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : 1))
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${walk(nested, ancestors, onCycle)}`).join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}
