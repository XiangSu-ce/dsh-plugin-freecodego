/**
 * Where the announcement bar's own decisions are kept.
 *
 * Two things live here, and both are the *client's* rather than the account's:
 * whether the bar is shown at all, and which announcements this browser has
 * already closed. The second exists because closing a notice is a round trip —
 * the read record is the backend's, so it holds on the account's other machines
 * (see `account-remotes.ts`), and this list is what keeps a notice closed when
 * that round trip fails. Without it, a failed acknowledgement would resurrect
 * the bar on the next poll, which reads as "the close button does not work".
 *
 * The list is bounded and pruned against what the backend still returns, so it
 * cannot grow forever: an announcement that has ended, or whose account read
 * record has caught up, is forgotten the next time the bar polls.
 *
 * @module client/announcement-preference
 */

/** Where the preference lives. Versioned: a future shape change must not be read as this one. */
const STORAGE_KEY = 'freecodego.announcements.v1'

/** How many dismissals are remembered. The bar shows one notice at a time, so this is far more than a session's worth. */
const MAX_DISMISSED = 50

/** Document event that announces a change to every live reader. */
export const ANNOUNCEMENT_PREFERENCE_EVENT = 'fcg:announcement-preference-changed'

/** The client's own announcement decisions. */
export interface AnnouncementPreference {
  /** Whether the top bar is shown. `false` is a user who asked not to be interrupted. */
  readonly bar: boolean
  /** Announcement ids this browser closed, newest last. */
  readonly dismissed: readonly number[]
}

/** The default: the bar is shown, nothing is dismissed. */
export const DEFAULT_ANNOUNCEMENT_PREFERENCE: AnnouncementPreference = { bar: true, dismissed: [] }

/** Keep only well-formed ids, so one corrupt entry cannot silence an unrelated notice. */
function normalizeDismissed(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const ids: number[] = []
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isFinite(entry) || entry <= 0) continue
    if (ids.includes(entry)) continue
    ids.push(entry)
  }
  return ids.slice(-MAX_DISMISSED)
}

/**
 * Normalize any parsed document into the current shape.
 * @param value - the parsed `localStorage` document.
 * @returns the decisions it carries, with unknown fields dropped.
 */
export function normalizeAnnouncementPreference(value: unknown): AnnouncementPreference {
  if (typeof value !== 'object' || value === null) return DEFAULT_ANNOUNCEMENT_PREFERENCE
  const record = value as { readonly bar?: unknown; readonly dismissed?: unknown }
  return {
    // Only an explicit `false` turns the bar off: an installation that stored
    // this document before the switch existed keeps its notices.
    bar: record.bar !== false,
    dismissed: normalizeDismissed(record.dismissed),
  }
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
 * @returns the stored decisions, or the default when nothing is stored.
 */
export function readAnnouncementPreference(): AnnouncementPreference {
  const store = storage()
  if (store === undefined) return DEFAULT_ANNOUNCEMENT_PREFERENCE
  try {
    const raw = store.getItem(STORAGE_KEY)
    if (raw === null || raw === '') return DEFAULT_ANNOUNCEMENT_PREFERENCE
    return normalizeAnnouncementPreference(JSON.parse(raw) as unknown)
  } catch {
    // Unreadable or not JSON: treat as the default rather than throwing on a
    // surface that has to keep rendering the page under it.
    return DEFAULT_ANNOUNCEMENT_PREFERENCE
  }
}

/**
 * Persist decisions and tell every live reader.
 * @param preference - the decisions to store.
 */
export function writeAnnouncementPreference(preference: AnnouncementPreference): void {
  const normalized = normalizeAnnouncementPreference(preference)
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    // A full or read-only store must not break the bar; the in-memory decision
    // still applies until the page is reloaded.
  }
  document.dispatchEvent(new Event(ANNOUNCEMENT_PREFERENCE_EVENT))
}

/**
 * Turn the bar on or off.
 * @param visible - whether the bar may be rendered.
 */
export function setAnnouncementBarVisible(visible: boolean): void {
  const current = readAnnouncementPreference()
  if (current.bar === visible) return
  writeAnnouncementPreference({ ...current, bar: visible })
}

/**
 * Remember that this browser closed one announcement.
 *
 * The bound is applied by dropping the oldest entries, so a busy account keeps
 * the narrow window of notices it is actually being shown.
 * @param announcementId - the announcement the user closed.
 */
export function dismissAnnouncement(announcementId: number): void {
  const current = readAnnouncementPreference()
  if (current.dismissed.includes(announcementId)) return
  writeAnnouncementPreference({ ...current, dismissed: [...current.dismissed, announcementId] })
}

/**
 * Forget dismissals the backend no longer returns.
 *
 * The list is the client's memory of its own round trips, and every entry it
 * still holds is an id the bar keeps consulting; once the backend stops
 * returning an announcement — it ended, or the read record caught up — the entry
 * has no work left to do. Called on every poll so the document stays as small as
 * the notices it is about.
 * @param liveIds - the ids the backend just returned.
 */
export function pruneAnnouncements(liveIds: readonly number[]): void {
  const current = readAnnouncementPreference()
  if (current.dismissed.length === 0) return
  const live = new Set(liveIds)
  const kept = current.dismissed.filter(id => live.has(id))
  if (kept.length === current.dismissed.length) return
  writeAnnouncementPreference({ ...current, dismissed: kept })
}

/**
 * Run a listener whenever the decisions change from anywhere in the page.
 *
 * Both writers are in the same document — the bar's close button and the page
 * that holds the switch — so the event is the whole channel. The `storage` event
 * is included for a second browser tab, where the same preference is the same
 * user's intent.
 * @param listener - called after every change.
 * @returns a disposer that removes the listeners.
 */
export function subscribeAnnouncementPreference(listener: () => void): () => void {
  document.addEventListener(ANNOUNCEMENT_PREFERENCE_EVENT, listener)
  // Registered on `window`, which exists wherever this client runs (the page
  // being decorated is the reason the module was loaded), so no probe is needed.
  window.addEventListener('storage', listener)
  return () => {
    document.removeEventListener(ANNOUNCEMENT_PREFERENCE_EVENT, listener)
    window.removeEventListener('storage', listener)
  }
}
