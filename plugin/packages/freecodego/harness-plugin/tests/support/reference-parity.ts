/**
 * Reading two header maps against each other, for the specs that pin this
 * plugin's identity to a reference implementation's.
 *
 * Why this is shared
 * ------------------
 * The comparison is the message. A parity assertion that fails with `false`
 * leaves a reader diffing two files by hand, and the diff is what the reference
 * itself would have printed: `=` agrees, `+` is this plugin's own field, `!` is a
 * divergence. Three providers now compare against three references, and a second
 * copy of the renderer is a second place for the format to drift — which would
 * make two specs disagree about what "diverges" looks like.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/support/reference-parity
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** One reference file this spec's transcription was read from. */
export interface ReferenceSource {
  /** Absolute path in the reference checkout, which is not part of this repository. */
  readonly path: string
  /** The digest of the bytes the transcription was read from. */
  readonly sha256: string
  /** What the file was read for, so a mismatch says what to re-read. */
  readonly what: string
}

/**
 * A field-by-field report of two header maps.
 *
 * @param actual - what this plugin sent.
 * @param expected - what the reference sends.
 * @param generated - names both sides generate per request, compared by presence.
 * @param divergences - names both sides send with different values on purpose,
 *   each already explained where it is declared; they are marked rather than
 *   reported as a failure.
 * @returns one line per field, sorted by name, indented for a failure message.
 */
export function headerReport(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
  generated: readonly string[] = [],
  divergences: readonly string[] = [],
): string {
  const names = [...new Set([...Object.keys(actual), ...Object.keys(expected), ...generated, ...divergences])].sort()
  return names.map((name) => {
    const mine = actual[name]
    const theirs = expected[name]
    if (generated.includes(name)) return `  = ${name}: ${String(mine ?? '(absent)')} (generated per request)`
    if (divergences.includes(name)) return `  ~ ${name}: sent ${String(mine ?? '(absent)')}, reference sends ${String(theirs)} (recorded divergence)`
    if (mine === theirs) return `  = ${name}: ${String(mine)}`
    if (theirs === undefined) return `  + ${name}: ${String(mine)} (this plugin only)`
    return `  ! ${name}: expected ${String(theirs)}, sent ${String(mine ?? '(absent)')}`
  }).join('\n')
}

/**
 * The reference files whose contents no longer match what was transcribed.
 *
 * A transcription compared against a file that has since changed is worse than no
 * comparison at all, so the recorded digests are checked whenever the checkout is
 * present — it is not part of this repository, which is why the callers skip the
 * check rather than fail on a missing path.
 * @param sources - the files this spec was transcribed from.
 * @returns one message per changed file, empty when every digest still matches.
 */
export function changedReferenceSources(sources: readonly ReferenceSource[]): readonly string[] {
  const changed: string[] = []
  for (const source of sources) {
    let digest: string
    try {
      digest = createHash('sha256').update(readFileSync(source.path)).digest('hex')
    } catch {
      // Absent is not a mismatch: the caller states that case with `skipIf`, and a
      // read here that raced a deletion is the same thing one moment later.
      continue
    }
    if (digest !== source.sha256) {
      changed.push(`${source.path} changed — re-read it (${source.what}) and update this spec`)
    }
  }
  return changed
}
