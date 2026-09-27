/**
 * The one safe way to read a Loader entry's activation state.
 *
 * `Entry.disabled` is not a field: the getter evaluates a `!!js` expression — and
 * walks the entry's parents — on every read, so an install that cannot supply what
 * that expression names makes the read throw. `app-boot` names such an entry an
 * activation failure rather than a disabled one (`inactiveEntries`), and it can
 * afford to look: it is the one place a broken row is *reported*.
 *
 * A plugin reading the same getter while reacting to the tree — every
 * `loader/entry-init`, every `loader/partial-dispose`, and the seeding walk this
 * plugin does at mount — turns one broken row into a broken tree instead. On a
 * desktop install that cannot import the official team modules, an unguarded read
 * in the seeding walk rejected the mount with `fatal load failure`, which costs
 * the whole Host for a warning about three modules.
 * @module
 */

/** The only part of a Loader entry this read needs. */
export interface LoaderEntryState {
  /** True when this entry or an owning parent is disabled; throws when its expression does. */
  readonly disabled: boolean
}

/**
 * An entry's resolved disabled state, or `undefined` when reading it throws.
 *
 * `undefined` is the answer a caller treats as "not mine to decide": the entry
 * cannot be running, and no one may act on a state the tree will not report.
 * @param entry - the Loader entry to read.
 * @returns the state, or `undefined` when the expression threw.
 */
export function disabledState(entry: LoaderEntryState): boolean | undefined {
  try {
    return entry.disabled
  } catch {
    return undefined
  }
}
