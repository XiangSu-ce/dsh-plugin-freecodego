/**
 * CCR (Compress-Cache-Retrieve) storage layer — TypeScript port of
 * Headroom's `crates/headroom-core/src/ccr/` (Apache-2.0, © Headroom
 * Maintainers).
 *
 * Compressed payloads embed `<<ccr:HASH>>` markers; the original bytes live
 * here keyed by the same hash so the model can call `headroom_retrieve` and
 * get the full text back. Lossy on the wire, lossless end-to-end.
 *
 * Process-local in-memory backend with the same idle-window TTL semantics as
 * the Rust production store: every successful `get` restarts the entry's
 * clock, capped by an absolute max lifetime measured from insertion.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/headroom/ccr
 */

import { createHash } from 'node:crypto'

export const DEFAULT_CAPACITY = 1_000
/** Idle window: 30 minutes, refreshed on every access. */
export const DEFAULT_TTL_MS = 30 * 60_000
/** Absolute max lifetime multiplier over the idle window. */
export const DEFAULT_MAX_LIFETIME_MULTIPLIER = 8

/** Canonical CCR key for a payload: SHA-256 → first 24 hex chars. Every
 * marker embedded in compressed output uses this width, so
 * `headroom_retrieve`'s `^[a-f0-9]{24}$` pattern matches them all. */
export function computeKey(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 24)
}

// A 12-char `hashOpaque` variant used to live here, documented as the hash inside
// opaque-cell `<<ccr:HASH,KIND,SIZE>>` markers. Both halves of that were wrong: no
// marker carries it (every one of them is written from `computeKey`), and nothing
// could have retrieved it if one had — `headroom_retrieve` validates
// `^[a-f0-9]{24}$`, and the number 12 does not match a 24-character pattern. Only
// `smart-crusher.ts` ever mentioned it, in the comment recording why it switched to
// `computeKey`. A dead export whose documentation describes a protocol that does
// not exist is worse than no export: it is the next reader's reason to use it.

interface Entry {
  payload: string
  createdAt: number
  lastAccessed: number
}

export class CcrStore {
  private readonly entries = new Map<string, Entry>()
  private cleanedAt = 0

  constructor(
    private readonly capacity = DEFAULT_CAPACITY,
    private readonly idleTtlMs = DEFAULT_TTL_MS,
    private readonly maxLifetimeMultiplier = DEFAULT_MAX_LIFETIME_MULTIPLIER,
  ) {}

  /**
   * Stash `payload` under `hash`; idempotent for identical content.
   *
   * Idempotent includes the eviction side effect, which is the half that is easy
   * to get wrong: keys are content hashes, so the same payload arrives over and
   * over in ordinary use (the same file read twice, the same failing command
   * rerun, the same JSON blob in two tool results). Dropping the oldest entry to
   * make room for content that is *already held* would destroy an original the
   * model can still see a `hash=` marker for — a retrieval that fails while the
   * bytes were never missing.
   */
  put(hash: string, payload: string): void {
    this.evictExpired()
    const now = Date.now()
    const existing = this.entries.get(hash)
    if (existing !== undefined) {
      if (!this.isExpired(existing, now)) {
        // Live copy: refresh it in place and keep its insertion clock, so the
        // absolute lifetime still starts when the model first saw the marker.
        existing.payload = payload
        existing.lastAccessed = now
        return
      }
      // Expired-but-unswept copy: a marker for this payload was just handed out,
      // so the row is replaced with a fresh one instead of being left for `get`
      // to refuse. That also drops it from the eviction order below.
      this.entries.delete(hash)
    }
    // Capacity: drop the oldest-inserted entry first.
    while (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
    this.entries.set(hash, { payload, createdAt: now, lastAccessed: now })
  }

  /** Look up `hash`; returns undefined when missing or expired. Refreshes the idle clock. */
  get(hash: string): string | undefined {
    const entry = this.entries.get(hash)
    if (entry === undefined) return undefined
    const now = Date.now()
    if (this.isExpired(entry, now)) {
      this.entries.delete(hash)
      return undefined
    }
    entry.lastAccessed = now
    return entry.payload
  }

  /**
   * Count of entries the model can still retrieve.
   *
   * Expired entries are filtered inline rather than swept first: the sweep is
   * throttled to once a minute, so calling it here would still count a dead
   * entry for up to a minute after it died. That matters because this number is
   * reported to the settings surface next to `retrieveMisses` — counting an
   * entry `get` would refuse tells the user they still hold originals they have
   * already lost.
   */
  get size(): number {
    const now = Date.now()
    let live = 0
    for (const entry of this.entries.values()) if (!this.isExpired(entry, now)) live += 1
    return live
  }

  /** Total bytes of retrievable payloads — informational, feeds the settings UI. */
  get bytes(): number {
    const now = Date.now()
    let total = 0
    for (const entry of this.entries.values()) {
      if (this.isExpired(entry, now)) continue
      total += Buffer.byteLength(entry.payload, 'utf8')
    }
    return total
  }

  /** Whether `entry` is past either its idle window or its absolute lifetime. */
  private isExpired(entry: Entry, now: number): boolean {
    return now - entry.lastAccessed > this.idleTtlMs || now - entry.createdAt > this.idleTtlMs * this.maxLifetimeMultiplier
  }

  private evictExpired(): void {
    const now = Date.now()
    // Throttle the sweep: entries expire lazily on get(); this pass just
    // keeps the population bounded when nothing is retrieved.
    if (now - this.cleanedAt < 60_000) return
    this.cleanedAt = now
    for (const [hash, entry] of this.entries) {
      if (this.isExpired(entry, now)) this.entries.delete(hash)
    }
  }
}
