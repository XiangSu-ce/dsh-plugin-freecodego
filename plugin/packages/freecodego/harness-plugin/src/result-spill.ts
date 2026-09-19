/**
 * Park cleared tool results where the model can still read them back.
 *
 * Why
 * ---
 * `cache-cold.ts` clears old tool results to reclaim context, and the marker it
 * leaves behind used to say the content "is not recoverable from this view". That
 * was true, and it was the defect: the session log still holds every byte, but the
 * model has no path back to it, so the only way to see a cleared result again is to
 * re-run the tool — re-reading the file, re-running the command — which spends the
 * tokens the clear just saved.
 *
 * This module closes that loop using storage the deployment already has. The
 * harness ships a spill capability family (`dsh-spill` / `dsh-spill-local` /
 * `dsh-spill-policy`) whose whole job is "keep oversized text out of context,
 * hand back a locator the model can read or grep". The FreeCodeGo composition
 * mounts it, so clearing can park text through it and put the locator in the
 * marker instead of a dead end. No new storage, no new retrieval tool: the model
 * reads the artifact with the file tools it already has.
 *
 * Boundaries
 * ----------
 * Best-effort, exactly like the shipped spill policy: a storage failure leaves the
 * result cleared under the plain marker rather than failing the request. Losing the
 * locator costs a re-read; it never costs correctness. Nothing here decides *what*
 * to clear — that stays in `cache-cold.ts`, where the cache-cold reasoning lives.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/result-spill
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import { clearedResultMarker } from './cache-cold.ts'
import { spillRetrievalGuidance } from './spill-recall.ts'

/**
 * The one spill operation this module uses.
 *
 * Declared structurally rather than by importing the service type, so the plugin
 * does not acquire a build-graph dependency on a capability it may run without —
 * and so this path is testable without a filesystem. The cost of that choice is
 * that the compiler cannot see this shape drift, so the fields below are kept
 * exactly as `SaveTextSpill`/`SpillRef` declare them: `source.kind` is the
 * discriminator Harness 0.1.6 introduced when it turned `SpillSource` into a
 * union (`'tool' | 'session-reference'`). A caller that omits it still works
 * against today's local backend — which reads only owner/suggestedName/content —
 * and would break silently against any backend that reads `source`.
 */
export interface SpillWriter {
  saveText(input: {
    readonly owner: { readonly sessionId: SessionId }
    readonly source: { readonly kind: 'tool'; readonly toolName: string; readonly callId: string; readonly label: string }
    readonly suggestedName: string
    readonly content: string
  }): Promise<{ readonly locator: string; readonly bytes: number; readonly retrievalHint: string }>
}

/** One result about to be cleared: the address it was called at, and its payload. */
export interface ClearedResultToSpill {
  readonly callId: string
  readonly tool: string
  readonly text: string
}

/**
 * Park each result and return the marker that should replace it.
 *
 * The returned map is keyed by tool-call id and holds only the results that were
 * genuinely parked; a target the backend rejects is simply absent, and the caller
 * falls back to the plain marker for it. That per-result granularity is why this
 * returns a map instead of a boolean: one unwritable artifact must not cost the
 * locators of the ones that succeeded.
 *
 * @param store - the mounted spill backend, or `undefined` when the composition has none.
 * @param sessionId - the owning session, so artifacts group under it.
 * @param targets - results about to be cleared, already filtered to those without a marker.
 * @param onError - called once per failure; never allowed to break the pass.
 * @returns marker text per call id, for the results that were parked.
 */
export async function spillClearedResults(
  store: SpillWriter | undefined,
  sessionId: SessionId,
  targets: readonly ClearedResultToSpill[],
  onError?: (target: ClearedResultToSpill, error: unknown) => void,
): Promise<Map<string, string>> {
  const markers = new Map<string, string>()
  if (store === undefined) return markers
  for (const target of targets) {
    // An empty payload has nothing to retrieve, so a locator pointing at an empty
    // file would be a longer marker that helps no one.
    if (target.text.trim() === '') continue
    try {
      const ref = await store.saveText({
        owner: { sessionId },
        source: { kind: 'tool', toolName: target.tool, callId: target.callId, label: 'result' },
        suggestedName: `${target.tool}-result.txt`,
        content: target.text,
      })
      // The marker states the size and the exact first call, because a model told
      // only "it can be read back" has to guess how to page a 200KB artifact — and
      // the two ways to guess wrong are reading it whole (which re-spends what the
      // clear reclaimed) and reading only its start (which silently loses the rest).
      markers.set(target.callId, clearedResultMarker({
        locator: ref.locator,
        retrievalHint: `${ref.retrievalHint} ${spillRetrievalGuidance({ bytes: ref.bytes, locator: ref.locator })}`,
      }))
    } catch (error) {
      try {
        onError?.(target, error)
      } catch {
        // A reporter that throws must not abandon the remaining targets.
      }
    }
  }
  return markers
}
