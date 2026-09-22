/**
 * Record helpers for the settings writers.
 *
 * Every settings writer follows the same shape: read the current record, drop
 * or replace one entry, persist the result. `delete copy[key]` is the shortest
 * way to drop an entry, but a dynamically computed delete is what
 * `typescript(no-dynamic-delete)` forbids, and a filtered rebuild states the
 * same thing without mutating a copy a caller may still be holding.
 */

/** A copy of `record` with `key` removed.
 * @param record - the record to copy.
 * @param key - the entry name to drop.
 * @returns the copy without that entry.
 */
export function omitRecordKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key))
}

/** A copy of `record` with every name in `keys` removed.
 * @param record - the record to copy.
 * @param keys - the entry names to drop.
 * @returns the copy without those entries.
 */
export function omitRecordKeys<T>(record: Readonly<Record<string, T>>, keys: Iterable<string>): Record<string, T> {
  const dropped = new Set(keys)
  return Object.fromEntries(Object.entries(record).filter(([name]) => !dropped.has(name)))
}
