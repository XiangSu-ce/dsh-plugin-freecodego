/**
 * The consolidation pass ("dream"): a fenced lease, a frozen snapshot, a
 * tool-free model call, and atomic topic writes.
 *
 * Why each of those four, in order
 * -------------------------------
 * **A lease, not a mutex.** Consolidation runs outside a request and can take
 * minutes, so it cannot hold an in-process lock that a restart would leak. A
 * lock file with an expiry is recoverable by construction: a crashed pass leaves
 * a lease that expires, and the next pass takes over. The one case that must not
 * be silently recovered is a *live* lease, which is reported as `lease-held`
 * rather than retried, because two passes consolidating the same observations
 * would each write a topic the other does not know about.
 *
 * **A snapshot, not a cursor.** The pass takes the observations that exist when
 * it starts and ignores everything captured afterwards. Those later observations
 * are not lost — they are simply the next pass's input. The alternative, letting
 * a running pass see arrivals, means the pass's output depends on how long it
 * took, which makes a bad consolidation impossible to reproduce.
 *
 * **No tools, at all.** The consolidation request is built with an empty tool
 * list. A model that can read the repository while consolidating can decide that
 * its job is to fix something, and the whole point of this pass is that it only
 * writes curated topics. `buildConsolidationRequest` is the only constructor for
 * that request, and the test asserts the list is empty — including a mutation
 * probe that adds one and expects a failure.
 *
 * **Atomic topic writes.** Every topic is written to a temporary file and
 * renamed over its target. A half-written topic is worse than a stale one: the
 * topic is what recall reads, and a truncated topic reads as a confident
 * statement that the user's notes stop mid-sentence.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/memory/dream
 */

/** Default lease lifetime: long enough for a slow model, short enough to recover. */
export const DEFAULT_LEASE_TTL_MS = 10 * 60_000

/** One captured observation, as the capture pass wrote it. */
export interface MemoryObservation {
  /** ULID, which is also the inbox file name. */
  readonly id: string
  /** Content hash, so a rewritten observation is detectable. */
  readonly sha256: string
  /** When it happened, in epoch milliseconds. */
  readonly capturedAt: number
  /** The distilled turn text. */
  readonly text: string
}

/** A held lease. */
export interface DreamLease {
  readonly owner: string
  readonly acquiredAt: number
  readonly expiresAt: number
}

/** The outcome of trying to take the lease. */
export type DreamLeaseResult =
  | { readonly ok: true; readonly lease: DreamLease; readonly superseded?: DreamLease }
  | { readonly ok: false; readonly heldBy: DreamLease }

/** The file operations a lease needs, injected so the guard is testable. */
export interface DreamIo {
  readonly read: (path: string) => string | undefined
  readonly write: (path: string, contents: string) => void
  /**
   * Move one path over another, without a reader ever seeing the target partial.
   *
   * Required rather than optional, because {@link commitTopics} cannot keep the
   * promise in this module's header without it: the header says atomic topic writes
   * are what makes a truncated topic impossible, and a port that may omit the rename
   * leaves a directly-written target reachable by omission — a half-written topic
   * reads as a confident statement that the user's notes stop mid-sentence.
   */
  readonly rename: (from: string, to: string) => void
  readonly remove: (path: string) => void
}

/** The lock file name inside the memory directory. */
export const DREAM_LEASE_FILENAME = 'dream.lock'

/**
 * Try to take the consolidation lease.
 *
 * An expired lease is taken over rather than respected — that is the recovery
 * path for a crashed pass — and the superseded lease is returned so the caller
 * can report that it recovered from a crash rather than assuming a clean start.
 * @param input - directory, owner id, clock, ttl, and the injected file operations.
 * @returns the lease, or the live lease that holds it.
 */
export function acquireDreamLease(input: {
  readonly directory: string
  readonly owner: string
  readonly now: number
  readonly ttlMs?: number
  readonly io: DreamIo
}): DreamLeaseResult {
  const path = `${input.directory}/${DREAM_LEASE_FILENAME}`
  const existing = readLease(path, input.io)
  if (existing !== undefined && existing.expiresAt > input.now) {
    return { ok: false, heldBy: existing }
  }
  const ttl = input.ttlMs ?? DEFAULT_LEASE_TTL_MS
  const lease: DreamLease = { owner: input.owner, acquiredAt: input.now, expiresAt: input.now + ttl }
  input.io.write(path, `${JSON.stringify(lease)}\n`)
  return existing === undefined ? { ok: true, lease } : { ok: true, lease, superseded: existing }
}

/** Read a lease file, tolerating an unreadable or malformed one. */
function readLease(path: string, io: DreamIo): DreamLease | undefined {
  const raw = io.read(path)
  if (raw === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const candidate = parsed as Partial<DreamLease>
    if (typeof candidate.owner !== 'string' || typeof candidate.expiresAt !== 'number' || typeof candidate.acquiredAt !== 'number') {
      return undefined
    }
    return { owner: candidate.owner, acquiredAt: candidate.acquiredAt, expiresAt: candidate.expiresAt }
  } catch {
    // A malformed lease is treated as absent, which lets the next pass proceed.
    // The alternative — refusing forever on a corrupt lock — turns one bad write
    // into a permanently disabled feature.
    return undefined
  }
}

/**
 * Read the *live* consolidation lease, if one is held.
 *
 * The consumer this exists for is `forget.ts`, whose `ForgetContext.leaseActive`
 * has to be answered from the same place the lease is written: a consumer that
 * tracked the lease in memory would report "no lease" after a restart that left
 * a live lease on disk, which is exactly the mid-write case the refusal exists
 * to catch. An expired lease is reported as absent — that is the crash-recovery
 * path, and treating it as held would make one bad pass disable forgetting until
 * someone deleted a file.
 *
 * @param input - directory, clock, and the injected file operations.
 * @returns the live lease, or undefined when none is held.
 */
export function readDreamLease(input: {
  readonly directory: string
  readonly now: number
  readonly io: DreamIo
}): DreamLease | undefined {
  const lease = readLease(`${input.directory}/${DREAM_LEASE_FILENAME}`, input.io)
  return lease !== undefined && lease.expiresAt > input.now ? lease : undefined
}

/**
 * Release the lease, if this owner still holds it.
 * @param input - directory, owner id, clock, and the injected file operations.
 * @returns true when the lease was removed by its holder.
 */
export function releaseDreamLease(input: {
  readonly directory: string
  readonly owner: string
  readonly io: DreamIo
}): boolean {
  const path = `${input.directory}/${DREAM_LEASE_FILENAME}`
  const existing = readLease(path, input.io)
  if (existing === undefined || existing.owner !== input.owner) return false
  input.io.remove(path)
  return true
}

/**
 * Freeze the observations that exist now.
 *
 * Arrivals after this call belong to the next pass; see the module header for
 * why that matters more than it looks.
 * @param observations - everything currently in the inbox, in any order.
 * @returns the snapshot, deterministically ordered by capture time then id.
 */
export function snapshotObservations(observations: readonly MemoryObservation[]): readonly MemoryObservation[] {
  return [...observations].sort((left, right) => left.capturedAt - right.capturedAt || left.id.localeCompare(right.id))
}

/** One curated topic the pass proposes to write. */
export interface TopicProposal {
  /** File name without extension. */
  readonly slug: string
  readonly title: string
  readonly markdown: string
  /** Observation ids this topic was derived from, for the evidence trail. */
  readonly sources: readonly string[]
}

/** What the consolidation pass proposes. */
export interface ConsolidationPlan {
  readonly topics: readonly TopicProposal[]
  /** True when the plan may be committed; false in `shadow`. */
  readonly commit: boolean
  readonly model?: string
  /** Present when the pass could not plan, with the reason. */
  readonly problem?: string
}

/** A model request as this pass constructs it. */
export interface ConsolidationRequest {
  readonly system: string
  readonly prompt: string
  /**
   * Always empty.
   *
   * Typed as an empty tuple rather than `readonly unknown[]` on purpose: the
   * only way to add a tool here is to change this type, which is a visible edit
   * rather than an extra array element.
   */
  readonly tools: readonly []
  readonly observations: readonly MemoryObservation[]
  readonly existingTopics: readonly string[]
}

/**
 * Build the consolidation request.
 *
 * The only constructor for one, so "the pass runs with no tools" is a property
 * of the type rather than a convention each call site has to remember.
 * @param input - the snapshot, the topics already present, and the routing labels.
 * @returns the request, with an empty tool list.
 */
export function buildConsolidationRequest(input: {
  readonly observations: readonly MemoryObservation[]
  readonly existingTopics: readonly string[]
  readonly instructions: string
}): ConsolidationRequest {
  return {
    system: input.instructions,
    prompt: renderObservations(input.observations),
    tools: [],
    observations: input.observations,
    existingTopics: input.existingTopics,
  }
}

/**
 * Characters of one observation's text that reach the consolidation prompt.
 *
 * The bound was documented and never implemented: the renderer promised one per
 * observation while embedding each text whole, and the store hands the port up to
 * a hundred records whose bodies it caps at 64 KiB each — measured, a single long
 * note put 65,572 characters into a prompt whose sibling surfaces had been bounded
 * all along. A record's text is distilled prose and a topic is written from its
 * gist, so the share is the same order the rest of this subsystem gives one record
 * when a model reads it (`MAX_FACT_TEXT_CHARS`, `MAX_MEMORY_EXCERPT_CHARS`), and the
 * cut is marked with the ellipsis those two use, so a reader of the prompt can tell
 * a short observation from a truncated one.
 */
export const MAX_OBSERVATION_PROMPT_CHARS = 400

/** One observation's text, cut to this prompt's per-record share. */
function observationText(text: string): string {
  return text.length > MAX_OBSERVATION_PROMPT_CHARS ? `${text.slice(0, MAX_OBSERVATION_PROMPT_CHARS)}…` : text
}

/** Render the snapshot into the pass's prompt, bounded per observation. */
function renderObservations(observations: readonly MemoryObservation[]): string {
  return observations
    .map(observation => `## ${observation.id} (${new Date(observation.capturedAt).toISOString()})\n${observationText(observation.text)}`)
    .join('\n\n')
}

/**
 * Commit a plan's topics atomically.
 *
 * Write-temp-then-rename, per topic, so no reader ever observes a partial topic
 * under its real name. A `commit: false` plan (the `shadow` stage) returns
 * without writing anything, which is what makes shadow safe to run in
 * production.
 * @param input - the plan, the topics directory, and the injected file operations.
 * @returns the slugs actually written.
 */
export function commitTopics(input: {
  readonly plan: ConsolidationPlan
  readonly directory: string
  readonly io: DreamIo
}): readonly string[] {
  if (!input.plan.commit) return []
  const written: string[] = []
  for (const topic of input.plan.topics) {
    if (!isSafeSlug(topic.slug)) continue
    const target = `${input.directory}/${topic.slug}.md`
    const temporary = `${target}.tmp`
    // The target is never written directly. It used to be — the temporary was
    // written and then removed while the real name was written in place, which is a
    // temp file that bought nothing and a topic a reader could catch half-written.
    // The render happens once, so what lands under the real name is byte-identical to
    // what was staged.
    const content = renderTopic(topic)
    input.io.write(temporary, content)
    input.io.rename(temporary, target)
    written.push(topic.slug)
  }
  return written
}

/** A slug that cannot escape its directory. */
function isSafeSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)
}

/** Render one topic, with its provenance. */
function renderTopic(topic: TopicProposal): string {
  const sources = topic.sources.length === 0 ? '' : `\n\nDerived from: ${topic.sources.join(', ')}\n`
  return `# ${topic.title}\n\n${topic.markdown.trim()}\n${sources}`
}
