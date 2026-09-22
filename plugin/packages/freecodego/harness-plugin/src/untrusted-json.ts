/**
 * Narrowing JSON that arrived from outside.
 *
 * Why
 * ---
 * Every provider body, catalog payload and stored blob reaches this plugin as
 * `unknown`: `JSON.parse` promises a value and nothing about its shape, so each
 * caller narrows it by hand. The narrowing is one line, which is why it was
 * written eighteen times in seventeen files — and why the copies had already
 * drifted by the time they were counted:
 *
 * - the same predicate carried six names (`record`, `object`, `plainRecord`,
 *   `recordOf`, `isDecision`, `isRecord`), so a reader asking "how does this module
 *   read a body" had nothing to search for
 * - six copies were a **type guard** and twelve a **coercion** with a default, and
 *   the defaults disagreed: `{}` in ten, `undefined` in two
 *   (`engineering-remote-utils.ts` and the span parser in `json-text.ts`). A caller
 *   handed the wrong one either crashed on the first property read or silently read
 *   a malformed body as an empty one
 * - the guard copies tested their operands in opposite order
 *   (`value !== null && typeof value === 'object'` in `engineering.ts`,
 *   `typeof value === 'object' && value !== null` in `hooks/surface.ts`). Both are
 *   correct, which is the point: the difference is invisible until someone edits
 *   the copy they happen to be reading
 * - `media-utils.ts` declared its copy as `Record<string, any>`, which discards the
 *   `unknown` one line after earning it and turns every later field read into an
 *   unchecked one
 *
 * The guard is the primitive and {@link asRecord} is derived from it, so there is
 * one predicate with two defaults rather than six names for one line.
 *
 * What deliberately is not here
 * -----------------------------
 * Two callers share the test but not the result, and folding them in would mean
 * exporting a cast — the thing this module exists to remove:
 *
 * - `engine-council.ts` narrows to `Partial<CouncilSettings>`, a type of its own.
 * - `headroom/smart-crusher.ts` tests a `JsonValue` in a branch that hands the value
 *   straight back to a field typed `JsonValue`, so widening it to a record of
 *   `unknown` fields is what would need the cast.
 *
 * `tests/upstream-contract-single-source.spec.ts` names both, so a third copy fails
 * the gate instead of joining them quietly.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/untrusted-json
 */

/**
 * Whether `value` is a plain JSON object.
 *
 * `null` is an object by `typeof` and an array is one by every other reading, so
 * both are excluded: a caller that wanted either has a predicate of its own
 * (`Array.isArray`) and one that assumed a record would read `length` or nothing at
 * all.
 *
 * @param value - any parsed JSON value, or anything at all.
 * @returns true when `value` can be read as a record of unknown fields.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `value` as a plain record, or an empty one.
 *
 * The empty default is the right one for reading a *body*: a field that is absent
 * and a body that was not an object at all both mean "this field is missing", and a
 * caller that had to tell those apart is the caller that wants
 * {@link maybeRecord}.
 *
 * @param value - any parsed JSON value.
 * @returns the record, or `{}` when `value` is not one.
 */
export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

/**
 * `value` as a plain record, or `undefined` when it is not one.
 *
 * For the caller that must not read a malformed payload as an empty one — a
 * persisted blob whose absence means "nothing was ever written" is a different
 * answer from a blob that failed to parse.
 *
 * @param value - any parsed JSON value.
 * @returns the record, or `undefined` when `value` is not one.
 */
export function maybeRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

/**
 * A non-empty trimmed string, or `undefined`.
 *
 * A whitespace-only field is absent rather than empty, because every caller is
 * reading a value it is about to display or send, and `'   '` is neither.
 *
 * @param value - any parsed JSON value.
 * @returns the trimmed string, or `undefined` when there was nothing to trim.
 */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * A finite number, or `undefined`.
 *
 * JSON cannot spell `NaN` or `Infinity`, but a value assembled by hand can carry
 * them, and `typeof value === 'number'` accepts both — so the bound is checked
 * rather than assumed by the callers that bounded it in their own copies.
 *
 * @param value - any parsed JSON value.
 * @returns the number, or `undefined` when `value` was not a finite one.
 */
export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
