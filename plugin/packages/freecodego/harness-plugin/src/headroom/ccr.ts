/**
 * CCR (Compress-Cache-Retrieve) storage layer — TypeScript port of
 * Headroom's `crates/headroom-core/src/ccr/` (Apache-2.0, © Headroom
 * Maintainers).
 *
 * Compressed payloads embed `<<ccr:HASH>>` markers; the original bytes live
 * here keyed by the same hash so the model can call `headroom_retrieve` and
 * get the full text back. Lossy on the wire, lossless end-to-end.
 *   * Process-local in-memory backend with the same idle-window TTL semantics as
   * the Rust production store: every successful `get` restarts the entry's
   * clock, capped by an absolute max lifetime measured from insertion.
   *
   * Capacity is bounded and eviction is oldest-inserted-first, with one exception
   * the promise above makes mandatory: an entry a *delivered* marker names is never
   * the victim, and a write with no other victim is refused rather than served by
   * spending it. See `pin`.
   *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/headroom/ccr
 */

import { createHash } from 'node:crypto'

/** Default entry ceiling before the oldest insertion is evicted. */
export const DEFAULT_CAPACITY = 1_000
/** Idle window: 30 minutes, refreshed on every access. */
export const DEFAULT_TTL_MS = 30 * 60_000
/** Absolute max lifetime multiplier over the idle window. */
export const DEFAULT_MAX_LIFETIME_MULTIPLIER = 8

/**
 * Canonical CCR key for a payload: SHA-256 → first 24 hex chars. Every marker
 * embedded in compressed output uses this width, so `headroom_retrieve`'s
 * `^[a-f0-9]{24}$` pattern matches them all.
 * @param payload - the payload to hash.
 * @returns the 24-character hex key.
 */
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

/**
 * Compressed-content store backing every `<<ccr:HASH,...>>` marker: bounded by
 * an entry ceiling, an idle TTL and an absolute lifetime, with delivered
 * markers pinned so capacity eviction never spends one.
 */
export class CcrStore {
  private readonly entries = new Map<string, Entry>()
  /**
   * Payloads the model has been handed a marker for.
   *
   * Capacity eviction may not spend one of these: the marker is the reason
   * dropping the original was safe, so deleting the entry leaves the model
   * holding a retrieval that fails while the bytes were never missing.
   *
   * Keyed by payload hash and **not** pruned when the entry goes, on purpose. An
   * entry that expired and was stashed again (the same file read twice, the same
   * command rerun) makes the marker the model already holds resolve again, and a
   * promise that comes back to life has to come back protected. The set therefore
   * grows by one 24-character key per delivered original — a long session holds a
   * few thousand of them, against the payloads themselves being megabytes.
   *
   * What this costs, stated rather than discovered: a promise outlives the
   * transcript that justified it when the host compacts the conversation, because
   * the port cannot observe host compaction (see `HEADROOM_PORT.reconciliation`).
   * The bias is deliberate and one-directional: an entry kept past its usefulness
   * costs one of `capacity` slots until its TTL expires, while an entry dropped
   * costs a retrieval the model may still ask for — and in a long session with
   * every live slot promised, lossy compression declines (writers ship the input)
   * until entries idle out. `status()`'s `ccrEntries` is how an operator sees a
   * store sitting at its ceiling.
   */
  private readonly promised = new Set<string>()
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
   *
   * `false` is the answer to two versions of that promise: a write this store
   * cannot honour at all, and a write whose price is a promise already outstanding
   * (an entry the model holds a marker for, which capacity may not spend). Every
   * writer in the subsystem reads it that way — the ones rendering a single value
   * put it back verbatim, the ones rendering a summary decline and ship the input.
   * @param hash - the content key to stash the payload under.
   * @param payload - the original bytes the hash names.
   * @returns true when the entry is held; false when the write was refused.
   */
  put(hash: string, payload: string): boolean {
    this.evictExpired()
    const now = Date.now()
    const existing = this.entries.get(hash)
    if (existing !== undefined) {
      if (!this.isExpired(existing, now)) {
        // Live copy: refresh it in place and keep its insertion clock, so the
        // absolute lifetime still starts when the model first saw the marker.
        existing.payload = payload
        existing.lastAccessed = now
        return true
      }
      // Expired-but-unswept copy: a marker for this payload was just handed out,
      // so the row is replaced with a fresh one instead of being left for `get`
      // to refuse. That also drops it from the eviction order below.
      this.entries.delete(hash)
    }
    // Capacity: drop the oldest-inserted entry that is not a live promise — see
    // `promised`. With every slot spent on a delivered original there is no victim
    // to take, and the write is refused: the caller's documented answer to `false`
    // is to render its value verbatim, which costs bytes instead of costing a
    // retrieval the model was told it had.
    while (this.entries.size >= this.capacity) {
      const victim = this.evictionVictim()
      if (victim === undefined) return false
      this.entries.delete(victim)
    }
    this.entries.set(hash, { payload, createdAt: now, lastAccessed: now })
    return true
  }

  /**
   * Record that a delivered marker names `hash`, so it outlives capacity pressure.
   *
   * Called where a rendering *ships* rather than where it is written: the staged
   * writes pin at commit, the read-skeleton and HTML branches pin after their
   * caller confirmed the rendering replaces the input. Pinning a stash the model
   * was never shown protects nothing real and costs a slot to a later result that
   * might have needed it, so the distinction is worth the extra call.
   * @param hash - the key a delivered marker names.
   */
  pin(hash: string): void {
    this.promised.add(hash)
  }

  /**
   * Whether `count` further entries can be stashed without spending a live promise.
   *
   * Asked *before* a rendering exists, by a caller that has to decide what to render:
   * `StagedCcrStore.put` refuses on a false here, which is what keeps a commit from
   * being the write that quietly drops a hash the rendering it is about to ship
   * names.
   *
   * Deliberately an over-estimate, in the safe direction: entries already present
   * are counted against the batch even though re-stashing one of them evicts
   * nothing, so a caller may be refused a write that would in fact have fit.
   * @param count - how many entries the caller intends to stash.
   * @returns true when the batch fits without spending a live promise.
   */
  canAccept(count: number): boolean {
    this.evictExpired()
    const needed = this.entries.size + count - this.capacity
    if (needed <= 0) return true
    let evictable = 0
    for (const hash of this.entries.keys()) if (!this.promised.has(hash)) evictable += 1
    return evictable >= needed
  }

  /** The oldest-inserted entry no delivered marker names, if any is left. */
  private evictionVictim(): string | undefined {
    for (const hash of this.entries.keys()) {
      if (!this.promised.has(hash)) return hash
    }
    return undefined
  }

  /**
   * The entry ceiling: above it `put` drops the oldest insertion — unless that
   * insertion is a promise `pin` recorded, in which case it looks further and
   * refuses when there is nothing else to take.
   *
   * Exposed because a *writer* has to know it. `StagedCcrStore` uses it to refuse
   * the write that would make one attempt evict its own earliest entries, which is
   * the one place the eviction policy breaks a promise instead of trading two.
   * Whether the *store* has room for the attempt at all is `canAccept`'s question,
   * and it is asked for the same reason — a rendering may not name an entry the
   * commit was refused.
   */
  get capacityLimit(): number {
    return this.capacity
  }

  /**
   * Look up `hash`; missing and expired entries both read as undefined.
   * Refreshes the idle clock of a hit.
   * @param hash - the content key to look up.
   * @returns the stashed payload, or undefined when absent or expired.
   */
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

/**
 * A store that holds its writes until the rendering that names them ships.
 *
 * Why this exists
 * ---------------
 * A compression attempt is a *search*: the tabular compaction builds a whole table
 * — writing an entry for every opaque cell it replaces — and only then measures
 * whether the table is worth adopting. Rejecting it afterwards is normal and
 * correct; leaving its entries behind is not. `put` documents the outcome it
 * refuses, and this is that outcome arriving from the other direction: an entry no
 * marker names occupies one of `capacity` slots, so enough of them evict an
 * original a delivered `hash=` marker still points at, and the model loses a
 * retrieval it was told it had. `runtime.ts` states the rule for the skeleton
 * ("a declined skeleton never leaves an entry the model could retrieve for no
 * reason"); this class is how a candidate that is still being decided keeps it.
 *
 * Used as a *scope*, one stage per candidate rendering, with the commit placed on
 * the return that ships it. Stages nest: a stage's `commit` writes into whatever
 * store it was built over, so a candidate accepted inside a larger one stays
 * pending until the larger one is accepted too.
 *
 * Reads pass through to the store being staged for, rather than answering from
 * the buffer: a compressor that asked for a payload while deciding would get the
 * truth either way, and `size`/`bytes` are what the settings panel reports.
 */
export class StagedCcrStore extends CcrStore {
  private readonly pending: { hash: string; payload: string }[] = []

  constructor(private readonly inner: CcrStore) {
    super()
  }

  /**
   * Queue a write; nothing reaches the store until {@link commit}.
   *
   * Refused — with `false` — once this attempt has queued as many entries as the
   * store holds, because beyond that point the commit would evict the attempt's
   * *own* earliest writes: the store keeps the newest insertions, so the oldest of
   * a too-large attempt are dropped by its own later ones, and those are exactly
   * the hashes the rendering it is about to ship names. The caller's answer is to
   * render that value verbatim (the crusher does) or to decline the compression
   * (the `hash=` writers do), never to ship a marker nothing backs.
   *
   * Two questions, and both are asked here because here is the last moment the
   * caller can still choose a different rendering. The first is this attempt's own
   * size: a batch larger than the store cannot be committed without its later
   * writes evicting its earliest ones. The second is the store's room for the batch
   * at all (`canAccept`) — once every live slot belongs to an original the model
   * holds a marker for, a commit has no victim it is allowed to take.
   */
  override put(hash: string, payload: string): boolean {
    if (this.pending.length >= this.inner.capacityLimit) return false
    // …and the store may have no room for this attempt at all: once every slot
    // belongs to an original the model holds a marker for, committing this batch
    // would evict one of them. Asked here, at `put`, because this is the last
    // moment a caller can still choose a different rendering — a commit that found
    // no victim has nothing to say to a rendering already built around its names.
    if (!this.inner.canAccept(this.pending.length + 1)) return false
    this.pending.push({ hash, payload })
    return true
  }

  override canAccept(count: number): boolean {
    return this.pending.length + count <= this.inner.capacityLimit && this.inner.canAccept(this.pending.length + count)
  }

  /**
   * Forwarded to the store this stage stages for, so a stage is never a place a
   * promise goes to die: `commit` pins what it writes, and a caller that pins a
   * hash itself reaches the real store by the same route.
   */
  override pin(hash: string): void {
    this.inner.pin(hash)
  }

  override get capacityLimit(): number {
    return this.inner.capacityLimit
  }

  override get(hash: string): string | undefined {
    return this.inner.get(hash)
  }

  override get size(): number {
    return this.inner.size
  }

  override get bytes(): number {
    return this.inner.bytes
  }

  /**
   * Write everything this stage collected into the store it stages for, and pin it.
   *
   * A commit is the moment its rendering ships — that is what the commit is placed
   * on — so these are the hashes the model can now see markers for, and they are
   * protected from capacity eviction from here on.
   *
   * It cannot be refused, which is why it returns nothing while `put` can say
   * `false`: acceptance was decided at `put` time (`canAccept`), and nothing writes
   * to the store this stage sits on between a `put` and the commit —
   * one compression attempt is synchronous. If that ever stops holding, the check
   * to fix is `put`'s: a commit that silently dropped a named write would be the
   * dangling-reference bug this class exists to make impossible.
   *
   * Every write pins, which is the whole point of the placement: at the top of a
   * nested staging the `pending` list holds the sub-stages' writes too, so the one
   * commit that reaches the store is also the one commit that promises for them.
   */
  commit(): void {
    for (const { hash, payload } of this.pending) this.inner.put(hash, payload)
    for (const { hash } of this.pending) this.inner.pin(hash)
    this.pending.length = 0
  }

  /** Entries this attempt has queued and not yet committed. */
  get pendingCount(): number {
    return this.pending.length
  }
}

/**
 * Run one candidate rendering against a stage of its own.
 *
 * The call shape of {@link StagedCcrStore}, and shared for the reason it exists:
 * the compressors and the runtime each decide twice — the compressor measures its
 * own savings ratio, then the caller measures the accepted text again — so the
 * commit belongs on the branch that adopts, not on the call that produced.
 *
 * `base === undefined` is the no-store call the compressors support for probes;
 * the attempt then runs un-staged, exactly as it did before this existed.
 *
 * @param base - the store to write into once the rendering is adopted.
 * @param render - one attempt, handed the stage to write through.
 * @returns the attempt's value and the commit that makes its writes real.
 */
export function stagedWrites<T>(base: CcrStore | undefined, render: (store: CcrStore | undefined) => T): { readonly value: T; readonly commit: () => void } {
  if (base === undefined) return { value: render(undefined), commit: () => undefined }
  const stage = new StagedCcrStore(base)
  return { value: render(stage), commit: () => stage.commit() }
}
