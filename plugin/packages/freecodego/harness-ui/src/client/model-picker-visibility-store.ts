/**
 * Where the model-picker visibility decisions are kept.
 *
 * The decisions are a small document in `localStorage`, plus the event that tells
 * every live reader in the page (and in a second tab) that it changed. Nothing in
 * here knows what a decision *means* — which providers default their priced rows
 * to hidden, which rows are named defaults, what "un-hiding" is — because that is
 * the policy, and it lives in {@link ./model-picker-visibility}. Split this way,
 * the reading of an untrusted document is one file that can be reasoned about on
 * its own, and the policy is one file that never has to think about JSON.
 *
 * Storage is *negative*: a provider or model is shown unless it is explicitly
 * recorded as hidden, and only the decisions that disagree with a default are
 * written. That is why the document is a list of exceptions rather than a
 * snapshot, and why un-hiding is *removing* a key rather than storing `true`.
 *
 * @module client/model-picker-visibility-store
 */

/** Where the preference lives. Versioned: a future shape change must not be
 * read as this one. */
const STORAGE_KEY = 'freecodego.modelPicker.visibility.v1'

/** Document event that announces a change to every live reader. */
export const MODEL_VISIBILITY_EVENT = 'fcg:model-visibility-changed'

/** Explicit hide/show decisions, keyed by provider and by model. */
export interface ModelPickerVisibility {
  /** Provider id → `false` when its whole section is hidden. */
  readonly providers: Readonly<Record<string, boolean>>
  /** `provider\u0000model` → `false` when that row is hidden. */
  readonly models: Readonly<Record<string, boolean>>
}

/** Nothing hidden: the picker as the Host composed it. */
export const EMPTY_MODEL_PICKER_VISIBILITY: ModelPickerVisibility = { providers: {}, models: {} }

/** Keep only well-formed decisions, so one corrupt entry cannot hide a section
 * nobody asked to hide.
 *
 * Both booleans are kept: with a curated provider (see
 * `DEFAULT_VISIBLE_MODELS` in {@link ./model-picker-visibility}) a stored `true`
 * is meaningful — it is a row the user switched on that starts off. A value that
 * agrees with the default is never stored, so the document stays a list of
 * exceptions either way. */
function normalizeRecord(value: unknown): Record<string, boolean> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, boolean> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'boolean') continue
    out[key] = entry
  }
  return out
}

/**
 * Normalize any parsed document into the current shape.
 * @param value - the parsed `localStorage` document.
 * @returns the decisions it carries, with unknown fields dropped.
 */
export function normalizeModelPickerVisibility(value: unknown): ModelPickerVisibility {
  if (typeof value !== 'object' || value === null) return EMPTY_MODEL_PICKER_VISIBILITY
  const record = value as { readonly providers?: unknown; readonly models?: unknown }
  return { providers: normalizeRecord(record.providers), models: normalizeRecord(record.models) }
}

/**
 * Copy a decision record with one key left out.
 *
 * Un-hiding is "no key", so restoring a decision has to *remove* an entry rather
 * than set it back to `true`. This is expressed as a copy that skips the key
 * instead of `delete record[key]`: the deletion rule refuses a computed key, and
 * a rebuilt record makes the invariant (only refusals are stored) harder to break
 * than a mutation does.
 * @param record - the decisions to copy.
 * @param key - the key to leave out.
 * @returns the copied decisions without that key.
 */
export function omitKey(record: Readonly<Record<string, boolean>>, key: string): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const [entryKey, value] of Object.entries(record)) {
    if (entryKey === key) continue
    out[entryKey] = value
  }
  return out
}

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    // A sandboxed frame denies access by throwing on the property itself.
    return undefined
  }
}

/**
 * Read the stored decisions.
 * @returns the stored decisions, or the empty default when nothing is stored.
 */
export function readModelPickerVisibility(): ModelPickerVisibility {
  const store = storage()
  if (store === undefined) return EMPTY_MODEL_PICKER_VISIBILITY
  try {
    const raw = store.getItem(STORAGE_KEY)
    if (raw === null || raw === '') return EMPTY_MODEL_PICKER_VISIBILITY
    return normalizeModelPickerVisibility(JSON.parse(raw) as unknown)
  } catch {
    // Unreadable or not JSON: treat as nothing hidden rather than throwing on a
    // menu that has to keep opening.
    return EMPTY_MODEL_PICKER_VISIBILITY
  }
}

/**
 * Persist decisions and tell every live reader.
 * @param visibility - the decisions to store.
 */
export function writeModelPickerVisibility(visibility: ModelPickerVisibility): void {
  const store = storage()
  try {
    store?.setItem(STORAGE_KEY, JSON.stringify(normalizeModelPickerVisibility(visibility)))
  } catch {
    // A full or read-only store must not break the panel; the in-memory
    // decision still applies until the page is reloaded.
  }
  document.dispatchEvent(new Event(MODEL_VISIBILITY_EVENT))
}

/**
 * Forget every decision, restoring the picker's full contents.
 * @returns the empty decisions, ready to apply.
 */
export function clearModelPickerVisibility(): ModelPickerVisibility {
  try {
    storage()?.removeItem(STORAGE_KEY)
  } catch {
    // Same as writing: a denied store leaves the picker on its composed list.
  }
  document.dispatchEvent(new Event(MODEL_VISIBILITY_EVENT))
  return EMPTY_MODEL_PICKER_VISIBILITY
}

/**
 * Run a listener whenever the decisions change from anywhere in the page.
 *
 * Both surfaces are in the same document — the settings panel writes and the
 * open picker re-reads — so the event is the whole channel. The `storage` event
 * is included for a second browser tab, where the same preference is the same
 * user's intent.
 * @param listener - called after every change.
 * @returns a disposer that removes the listeners.
 */
export function subscribeModelPickerVisibility(listener: () => void): () => void {
  document.addEventListener(MODEL_VISIBILITY_EVENT, listener)
  // The `storage` event is the second tab's copy of the same decision. It is
  // registered on `window`, which exists wherever this client runs (the page
  // being decorated is the reason the module was loaded), so no environment
  // probe is needed.
  window.addEventListener('storage', listener)
  return () => {
    document.removeEventListener(MODEL_VISIBILITY_EVENT, listener)
    window.removeEventListener('storage', listener)
  }
}
