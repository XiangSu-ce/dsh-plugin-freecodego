/**
 * Durable archive for CCR originals, kept by the Harness's own spill store.
 *
 * Why
 * ---
 * Headroom compresses a tool result and parks the original in `CcrStore`, whose
 * entries are process-local, idle-expiring and capacity-bounded. That is the
 * ported behaviour, and on its own it is a deliberate trade: a lost entry costs
 * one tool re-run, never correctness. Composed with the Harness it stops being
 * deliberate, because the Harness ships a capability whose entire job is this —
 * `dsh-spill` saves oversized text through `ctx.spillStore.saveText()` and hands
 * back a durable locator the model reads or greps. Measured against that, the
 * plugin's marker was the *weaker* of two answers to one question:
 *
 * 1. A restart, a 30-minute idle window or a full store dropped originals the
 *    Harness would have kept on disk, and the model could only learn that by
 *    asking and being refused.
 * 2. The Harness's own policy cannot stand in for the archive here. It skips
 *    `read` results outright (the read → spill → read-again loop), and it bounds
 *    what the waterfall accepted — so a payload Headroom brought *under* its cap
 *    is never spilled by it at all. Both are exactly the payloads Headroom
 *    compresses: read output and large-but-fittable results.
 *
 * So the originals are parked through the Harness's store, which becomes the
 * system of record for the bytes, while `CcrStore` stays the fast path and the
 * whole answer in a composition with no backend. Nothing else about the
 * compression pipeline changes: no marker spelling, no ratio, no pinning rule.
 *
 * The locator also has to reach the *transcript*, not just this module's memory.
 * A restart replays the delivered text and nothing else, so an in-process map of
 * `hash → locator` is exactly the guarantee that expires with the process. So a
 * rendering that names an archived original is delivered with one more line —
 * where the durable copy is, and how the backend says to read it — which is how
 * the model (and the next process) can still find the bytes with the Harness's
 * own file tools, and how `headroom_retrieve` answers for a hash whose in-memory
 * entry is gone.
 *
 * Boundaries
 * ----------
 * Best-effort, like `result-spill.ts` and like the Harness's own policy: an
 * archive failure is logged and leaves the in-memory entry as the only copy,
 * which is what the composition had before this existed. Payloads below
 * {@link DEFAULT_ARCHIVE_MIN_BYTES} are not archived — a session that compresses
 * hundreds of small results would otherwise leave hundreds of files whose loss
 * costs one re-read each. And this reads a locator back as a path when the
 * backend says that is how artifacts are read; a locator the plugin cannot
 * resolve degrades to the locator being named in the refusal, never to a claim
 * that the bytes are gone.
 *
 * @module @deepseek-ai/dsh-freecodego/harness-plugin/headroom/ccr-spill
 */

import { readFile } from 'node:fs/promises'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SpillWriter } from '../result-spill.ts'
import { CcrStore } from './ccr.ts'

/**
 * Payloads at or above this size are archived.
 *
 * Set below the Harness's own `spill-policy` cap (50 KB in the shipped base
 * composition) on purpose, so the two do not store the same bytes twice for the
 * same result: below the cap the policy never sees an oversized result, and what
 * it leaves inline is what Headroom compresses.
 */
export const DEFAULT_ARCHIVE_MIN_BYTES = 8 * 1024

/** The call an original is being archived for, as the spill backend records it. */
export interface SpillArchiveOwner {
  readonly sessionId: SessionId
  readonly toolName: string
  /** The model-issued call id of the call being compressed, when the seam carries one. */
  readonly callId: string
}

/** The two logging levels this module uses; `ctx.logger` satisfies it. */
export interface SpillArchiveLogger {
  debug?(message: string): void
  warn(message: string): void
}

export interface SpillArchiveOptions {
  /** Resolved per write, because the service may be mounted after this is built. */
  readonly store: () => SpillWriter | undefined
  readonly logger?: SpillArchiveLogger | undefined
  readonly minBytes?: number
  /**
   * Read an artifact back from its locator. The default treats the locator as a
   * path, which is what the local backend hands out and what `spill_recall`
   * already relies on; a backend whose locator is a URI fails this read, is
   * logged, and still gets its locator named in the refusal.
   */
  readonly readArtifact?: (locator: string) => Promise<string>
}

/**
 * Parks CCR originals in the mounted spill store and answers for them later.
 *
 * Entries are keyed by CCR hash, so a payload archived once is never archived
 * again: the hashes are content addresses, and the same file read twice is the
 * same artifact.
 */
export class SpillArchive {
  private readonly refs = new Map<string, { readonly locator: string; readonly retrievalHint: string }>()
  private readonly inflight = new Map<string, Promise<void>>()
  private readonly minBytes: number
  private readonly readArtifact: (locator: string) => Promise<string>
  private owner: SpillArchiveOwner | undefined
  private archived = 0
  private failures = 0

  constructor(private readonly options: SpillArchiveOptions) {
    this.minBytes = options.minBytes ?? DEFAULT_ARCHIVE_MIN_BYTES
    this.readArtifact = options.readArtifact ?? (locator => readFile(locator, 'utf8'))
  }

  /** Artifacts written since this archive was built. */
  get archivedCount(): number {
    return this.archived
  }

  /** Archive attempts the backend refused or that failed, for the same reason. */
  get failureCount(): number {
    return this.failures
  }

  /**
   * Set the call the next writes belong to.
   *
   * The compressors write synchronously from inside one `tools/post-execute`
   * call, so the owner is ambient state rather than an argument threaded through
   * every store signature. A write with no owner is not archived: the backend
   * groups artifacts by session, and `spill-local` rejects a save without one.
   */
  setOwner(owner: SpillArchiveOwner | undefined): void {
    this.owner = owner
  }

  /**
   * Archive `payload` under its CCR hash, unless it is already held or below the
   * floor. Never throws and never blocks its caller: the write is queued here and
   * the model finds it when it asks.
   * @param hash - the content key the marker in the delivered text names.
   * @param payload - the original bytes, exactly as the store holds them.
   */
  record(hash: string, payload: string): void {
    if (this.refs.has(hash) || this.inflight.has(hash)) return
    if (Buffer.byteLength(payload, 'utf8') < this.minBytes) return
    const store = this.options.store()
    if (store === undefined) return
    const owner = this.owner
    if (owner === undefined) {
      this.options.logger?.debug?.(`freecodego: headroom original ${hash} stays in memory only, because the tool call that produced it has no session owner to archive it under`)
      return
    }
    const save = store.saveText({
      owner: { sessionId: owner.sessionId },
      source: { kind: 'tool', toolName: owner.toolName, callId: owner.callId, label: 'headroom-original' },
      suggestedName: `headroom-${hash}.txt`,
      content: payload,
    }).then(ref => {
      this.refs.set(hash, { locator: ref.locator, retrievalHint: ref.retrievalHint })
      this.archived += 1
    }).catch((error: unknown) => {
      this.failures += 1
      this.options.logger?.warn(`freecodego: could not archive the original for hash ${hash}, so it stays retrievable only while it is in memory: ${String(error)}`)
    }).finally(() => {
      this.inflight.delete(hash)
    })
    this.inflight.set(hash, save)
  }

  /**
   * The locator for an archived original, waiting for a save still in flight.
   * @param hash - the content key the marker names.
   * @returns the locator, or `undefined` when nothing archived that hash.
   */
  async locatorFor(hash: string): Promise<string | undefined> {
    return (await this.refFor(hash))?.locator
  }

  /**
   * The artifact for an archived original, waiting for a save still in flight.
   * @param hash - the content key the marker names.
   * @returns the locator and the backend's retrieval guidance, or `undefined`.
   */
  async refFor(hash: string): Promise<{ readonly locator: string; readonly retrievalHint: string } | undefined> {
    const pending = this.inflight.get(hash)
    if (pending !== undefined) await pending
    return this.refs.get(hash)
  }

  /**
   * Read an archived original back.
   * @param hash - the content key the marker names.
   * @returns the original text, or `undefined` when it was not archived or the
   * locator cannot be read here — a backend-shaped failure, reported by the
   * caller without claiming the bytes were never kept.
   */
  async recover(hash: string): Promise<string | undefined> {
    const locator = await this.locatorFor(hash)
    if (locator === undefined) return undefined
    try {
      return await this.readArtifact(locator)
    } catch (error: unknown) {
      this.options.logger?.warn(`freecodego: archived original for hash ${hash} could not be read back from ${locator}: ${String(error)}`)
      return undefined
    }
  }

  /** Wait for every archive write queued so far; for tests and for a drain. */
  async settle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight.values()])
  }
}

/**
 * CCR references in a delivered rendering, in both spellings the compressors
 * write: the runtime's `hash=<24 hex>` suffix and the crusher's inline
 * `<<ccr:HASH,KIND,SIZE>>` / `<<ccr:HASH N_rows_offloaded>>` markers. The hash is
 * the same 24 characters in all three, which is why one pattern reads them.
 */
const ARCHIVED_REFERENCE = /hash=([a-f0-9]{24})|<<ccr:([a-f0-9]{24})/gu

/**
 * How much of a compression's saving the archive notice may spend: one
 * twentieth.
 *
 * The notice is appended after the branch already decided the rendering was
 * worth shipping, so it must not be able to move a delivery back across that
 * bar. Charging it against the bytes *saved* rather than the bytes delivered
 * makes the bound hold in both directions: a rendering that saved 20x the notice
 * is at worst 5% larger than it was measured to be, and it still ships smaller
 * than the original by the whole rest of the saving.
 */
export const ARCHIVE_NOTICE_SHARE = 20

/**
 * Append where the durable copy of a rendering's originals lives.
 *
 * One line per distinct artifact, all or nothing: a rendering that named three
 * archived originals should not carry one locator and imply the other two are
 * gone. `savedBytes` is what keeps the notice from costing a delivery its
 * acceptance, so a rendering whose saving is too small to pay for it is
 * delivered exactly as the branch rendered it — the in-memory entry is still the
 * fast path there, and the marker still names its hash.
 *
 * @param archive - the archive holding this session's artifacts.
 * @param compressed - the rendering the branch decided to ship.
 * @param savedBytes - bytes the rendering saved against the block it replaced.
 * @returns the rendering, with the locator lines when they fit and were archived.
 */
export async function attachArchiveNotices(archive: SpillArchive, compressed: string, savedBytes: number): Promise<string> {
  if (savedBytes <= 0) return compressed
  const hashes = new Set<string>()
  for (const match of compressed.matchAll(ARCHIVED_REFERENCE)) hashes.add(match[1] ?? match[2] ?? '')
  if (hashes.size === 0) return compressed
  const located = new Set<string>()
  const notices: string[] = []
  for (const hash of hashes) {
    const ref = await archive.refFor(hash)
    if (ref === undefined || located.has(ref.locator)) continue
    located.add(ref.locator)
    notices.push(`\n[Full original archived at ${ref.locator}. ${ref.retrievalHint}]`)
  }
  if (notices.length === 0) return compressed
  const notice = notices.join('')
  if (Buffer.byteLength(notice, 'utf8') * ARCHIVE_NOTICE_SHARE > savedBytes) return compressed
  return `${compressed}${notice}`
}

/**
 * The CCR store the runtime actually uses: every held write is archived.
 *
 * A refused write is not archived, matching the reason it is refused — the
 * caller ships the input and embeds no marker, so there is no promise to keep.
 * Subclassing is what keeps this honest: the runtime's staged writes reach the
 * base store only when a rendering is committed, so the archive records exactly
 * the entries the delivered text can name.
 */
export class ArchivingCcrStore extends CcrStore {
  constructor(
    private readonly archive: SpillArchive,
    bounds: { readonly capacity?: number; readonly idleTtlMs?: number; readonly maxLifetimeMultiplier?: number } = {},
  ) {
    super(bounds.capacity, bounds.idleTtlMs, bounds.maxLifetimeMultiplier)
  }

  override put(hash: string, payload: string): boolean {
    const held = super.put(hash, payload)
    if (held) this.archive.record(hash, payload)
    return held
  }
}
