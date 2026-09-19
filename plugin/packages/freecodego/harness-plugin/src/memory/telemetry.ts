/**
 * Memory telemetry: counts, durations, booleans and fixed enums — nothing else.
 *
 * Why a schema rather than a convention
 * ------------------------------------
 * Telemetry is the easiest place in a feature to leak what the feature knows. A
 * memory pipeline sees the user's statements, topic names, keywords, file paths
 * and the model's output; an innocuous `{ topic: slug }` field would put a
 * distilled version of the user's private notes into whatever collects metrics,
 * permanently, with no way to un-send it.
 *
 * `console.log` review does not survive contact with a growing feature, so the
 * boundary is enforced instead of documented: every event is *built* through
 * `buildMemoryTelemetry`, which refuses an unknown field and refuses a string
 * that is not one of the declared values for its field. A free-text field cannot
 * be added by accident, because there is no shape that would accept one.
 *
 * The refusal is a thrown error rather than a dropped field. Silently dropping
 * would leave a developer believing their metric is being collected; failing
 * loudly in a test is how the mistake gets fixed.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/memory/telemetry
 */

/** A field's declared shape. `enum:...` names the only strings it may hold. */
export type TelemetryFieldSpec =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'count' }
  | { readonly kind: 'durationMs' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }

/** Every memory telemetry event, with the exact fields each one may carry. */
export const MEMORY_TELEMETRY_SCHEMA = {
  'memory.capture': {
    outcome: { kind: 'enum', values: ['captured', 'skipped', 'failed'] },
    skipReason: { kind: 'enum', values: ['disabled', 'failed-turn', 'interrupted', 'empty', 'duplicate'] },
    turns: { kind: 'count' },
    truncated: { kind: 'boolean' },
    durationMs: { kind: 'durationMs' },
  },
  'memory.dream': {
    outcome: { kind: 'enum', values: ['started', 'completed', 'skipped', 'failed', 'lease-held'] },
    stage: { kind: 'enum', values: ['off', 'record_only', 'shadow', 'active'] },
    observations: { kind: 'count' },
    topicsWritten: { kind: 'count' },
    commits: { kind: 'count' },
    toolCalls: { kind: 'count' },
    durationMs: { kind: 'durationMs' },
  },
  'memory.recall': {
    outcome: { kind: 'enum', values: ['hit', 'miss', 'disabled'] },
    strategy: { kind: 'enum', values: ['selector', 'lexical'] },
    candidates: { kind: 'count' },
    selected: { kind: 'count' },
    durationMs: { kind: 'durationMs' },
  },
  'memory.forget': {
    outcome: { kind: 'enum', values: ['forgotten', 'refused'] },
    refusal: {
      kind: 'enum',
      values: ['broad-request', 'stale-evidence', 'path-traversal', 'symlink', 'protected', 'unknown-archive', 'lease-active'],
    },
    durationMs: { kind: 'durationMs' },
  },
  'memory.retention': {
    outcome: { kind: 'enum', values: ['swept', 'skipped', 'failed'] },
    archived: { kind: 'count' },
    removed: { kind: 'count' },
    durationMs: { kind: 'durationMs' },
  },
} as const

/**
 * The schema's shape, checked here rather than with a `satisfies` clause.
 *
 * `satisfies` would be the idiomatic way to write this check, but the
 * toolchain's parser rejects `as const satisfies`, so a typed alias does the
 * same job: assigning the literal to this type fails to compile the moment a
 * field spec drifts out of shape.
 */
type MemoryTelemetrySchema = Readonly<Record<string, Readonly<Record<string, TelemetryFieldSpec>>>>

/** Compile-time proof that every entry above is a valid field spec. */
export const MEMORY_TELEMETRY_SCHEMA_SHAPE: MemoryTelemetrySchema = MEMORY_TELEMETRY_SCHEMA

/** The name of one telemetry event. */
export type MemoryTelemetryEvent = keyof typeof MEMORY_TELEMETRY_SCHEMA

/** A value a telemetry field may hold. */
export type TelemetryValue = boolean | number | string

/** A built telemetry record: a fixed event name and its whitelisted fields. */
export interface MemoryTelemetryRecord {
  readonly event: MemoryTelemetryEvent
  readonly fields: Readonly<Record<string, TelemetryValue>>
}

/**
 * Build one telemetry record, or refuse the attempt.
 * @param event - the event name; must be one of the schema's keys.
 * @param fields - the field values; every key must be declared, and every string
 *   must be one of that field's declared values.
 * @returns the record, frozen.
 * @throws When the event is unknown, a field is undeclared, or a value does not
 *   fit its declared shape.
 */
export function buildMemoryTelemetry(
  event: MemoryTelemetryEvent,
  fields: Readonly<Record<string, unknown>>,
): MemoryTelemetryRecord {
  const schema = MEMORY_TELEMETRY_SCHEMA[event] as Readonly<Record<string, TelemetryFieldSpec>> | undefined
  if (schema === undefined) {
    throw new Error(`unknown memory telemetry event "${String(event)}"`)
  }
  const built: Record<string, TelemetryValue> = {}
  for (const [key, value] of Object.entries(fields)) {
    const spec = schema[key]
    if (spec === undefined) {
      // The important refusal: this is where `{ topic: '...' }` dies.
      throw new Error(`memory telemetry "${event}" has no field "${key}"; free-text fields are not collectable`)
    }
    built[key] = coerceField(event, key, spec, value)
  }
  return Object.freeze({ event, fields: Object.freeze(built) })
}

/** Validate one value against its declared shape. */
function coerceField(
  event: MemoryTelemetryEvent,
  key: string,
  spec: TelemetryFieldSpec,
  value: unknown,
): TelemetryValue {
  if (spec.kind === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`memory telemetry "${event}.${key}" must be a boolean`)
    return value
  }
  if (spec.kind === 'count' || spec.kind === 'durationMs') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`memory telemetry "${event}.${key}" must be a non-negative finite number`)
    }
    return value
  }
  if (typeof value !== 'string') {
    throw new Error(`memory telemetry "${event}.${key}" must be one of ${spec.values.join(', ')}`)
  }
  if (!spec.values.includes(value)) {
    throw new Error(`memory telemetry "${event}.${key}" got "${value}"; allowed values are ${spec.values.join(', ')}`)
  }
  return value
}

/**
 * Whether one value could have been produced by any telemetry event.
 *
 * The property the schema exists to guarantee, exposed for the test that proves
 * it: every string a telemetry record can hold is a declared enum member, so no
 * record can carry arbitrary text.
 * @param value - the value to test.
 * @returns true when the value is a boolean, a finite number, or a string that
 *   appears in at least one declared enum.
 */
export function isCollectableTelemetryValue(value: unknown): boolean {
  if (typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'string') return false
  return declaredStrings().has(value)
}

/** Every string any field of any event declares. */
function declaredStrings(): ReadonlySet<string> {
  const declared = new Set<string>()
  for (const fields of Object.values(MEMORY_TELEMETRY_SCHEMA) as readonly Readonly<Record<string, TelemetryFieldSpec>>[]) {
    for (const spec of Object.values(fields)) {
      if (spec.kind === 'enum') for (const value of spec.values) declared.add(value)
    }
  }
  return declared
}
