/**
 * Freshness for durable memory.
 *
 * Why a memory needs an age at all
 * --------------------------------
 * A recalled memory is evidence, and evidence without a date is a trap: a note
 * that "the build needs flag X" is actionable the day it is written and
 * misleading a quarter later. The plugin already injects recall excerpts after
 * compaction (`rehydration.ts`), and it already carried one hard-coded
 * `STALE_MEMORY_DAYS = 7` constant. This module replaces that single threshold
 * with the four-band vocabulary OpenClaude's `src/memdir/memoryAge.ts` uses, so
 * the *prompt* can say how old a fact is instead of the reader having to guess.
 *
 * Two decisions worth stating:
 *
 * - **A negative age is fresh, not ancient.** Memory timestamps and the current
 *   clock come from the same machine, but a store copied between machines, a
 *   restored backup, or a user-set clock can put `createdAt` in the future.
 *   Clamping to zero keeps that case from producing a nonsensical label.
 * - **The label is a duration, not a sentence.** Callers that want prose use
 *   {@link memoryFreshnessNote}; callers that render a badge use the duration.
 *   Composing prose once here and re-parsing it there is how two surfaces end up
 *   disagreeing about the same record.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/memory/memory-age
 */

export type MemoryFreshness = 'fresh' | 'recent' | 'stale' | 'ancient'

export const MEMORY_FRESH_MS = 24 * 60 * 60 * 1_000
export const MEMORY_RECENT_MS = 7 * 24 * 60 * 60 * 1_000
export const MEMORY_STALE_MS = 30 * 24 * 60 * 60 * 1_000

export interface MemoryAge {
  /** Non-negative milliseconds since the record was written. */
  readonly ageMs: number
  readonly freshness: MemoryFreshness
  /** A short duration such as `3 days`; never a full sentence. */
  readonly label: string
}

function formatDuration(ageMs: number): string {
  if (ageMs < 60_000) return 'just now'
  if (ageMs < 3_600_000) {
    const minutes = Math.floor(ageMs / 60_000)
    return `${minutes} minute${minutes === 1 ? '' : 's'}`
  }
  if (ageMs < 86_400_000) {
    const hours = Math.floor(ageMs / 3_600_000)
    return `${hours} hour${hours === 1 ? '' : 's'}`
  }
  const days = Math.floor(ageMs / 86_400_000)
  return `${days} day${days === 1 ? '' : 's'}`
}

/** Classify one record's age against the current clock. */
export function describeMemoryAge(createdAt: number, now: number): MemoryAge {
  const ageMs = Math.max(0, now - createdAt)
  const freshness: MemoryFreshness =
    ageMs <= MEMORY_FRESH_MS ? 'fresh'
      : ageMs <= MEMORY_RECENT_MS ? 'recent'
        : ageMs <= MEMORY_STALE_MS ? 'stale'
          : 'ancient'
  return { ageMs, freshness, label: formatDuration(ageMs) }
}

/**
 * A one-line caveat to append when a recalled memory is injected into a prompt,
 * or `undefined` when the record is fresh enough to need none.
 */
export function memoryFreshnessNote(age: MemoryAge): string | undefined {
  if (age.freshness === 'fresh') return undefined
  if (age.freshness === 'recent') return `Recorded ${age.label} ago; re-check anything that may have changed since.`
  return `Recorded ${age.label} ago and may be out of date; verify before relying on it.`
}
