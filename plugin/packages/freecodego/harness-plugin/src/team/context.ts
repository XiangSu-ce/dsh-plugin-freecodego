/**
 * Manual context control: compact now, and snip a chosen span.
 *
 * Compaction in the Harness is trigger-driven — pressure, or a provider's
 * context-overflow report — and the automatic pruner and compactor ship
 * disabled. That leaves the one case a model is best at noticing uncovered: it
 * knows it has finished with the 200 lines of type definitions it read twenty
 * steps ago, and it can say so long before a pressure threshold agrees.
 *
 * This module exposes that as two decisions rather than one knob:
 *
 * - **compact now** summarizes useful history below the automatic threshold,
 *   which is the `/compact` a person would run.
 * - **snip** replaces a chosen span with one summary node, which is how a model
 *   drops a region it has already extracted what it needs from.
 *
 * The engine is optional by design. A composition without `ctx.compaction` must
 * still load and must say so, instead of failing a tool call that looked
 * available; `available()` is the single place that answers.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/team/context
 */

import type { Context } from '@deepseek-ai/cordis'

/** Structural view of the compaction seam — only the parts this module calls. */
interface CompactionEngineLike {
  compactNow(agent: unknown, signal: AbortSignal, sourceCommandId?: string): Promise<{ readonly compactionId?: string; readonly summarySeq?: number; readonly shadowedRange?: { readonly start: number; readonly end: number } } | null>
  compactRegion(start: number, end: number, agent: unknown, signal?: AbortSignal): Promise<{ readonly compactionId?: string; readonly summarySeq?: number; readonly shadowedRange?: { readonly start: number; readonly end: number } }>
}

export interface ContextControlResult {
  readonly action: 'compact' | 'snip'
  readonly changed: boolean
  readonly compactionId?: string
  /** Inclusive surface-seq span that was replaced, when the engine reported one. */
  readonly shadowedRange?: { readonly start: number; readonly end: number }
  readonly detail: string
}

/** Everything this module needs from an agent, and nothing else. */
export interface ContextControlAgent {
  readonly session: {
    readonly seq?: number
    snapshotEvents(): readonly { readonly seq: number; readonly type: string }[]
  }
}

export class TeamContextControl {
  constructor(private readonly ctx: Context) {}

  /** The seam, when this composition mounted a compaction engine. */
  private engine(): CompactionEngineLike | undefined {
    try {
      const service = (this.ctx as unknown as { get(name: string): unknown }).get('compaction')
      if (service === null || typeof service !== 'object') return undefined
      const candidate = service as Partial<CompactionEngineLike>
      return typeof candidate.compactNow === 'function' && typeof candidate.compactRegion === 'function' ? candidate as CompactionEngineLike : undefined
    } catch {
      return undefined
    }
  }

  available(): { readonly ok: boolean; readonly reason?: string } {
    return this.engine() === undefined
      ? { ok: false, reason: 'no compaction engine is mounted in this composition; enable compaction or use the /compact command' }
      : { ok: true }
  }

  /** Summarize useful history now, below the automatic pressure threshold. */
  async compactNow(agent: ContextControlAgent, signal: AbortSignal): Promise<ContextControlResult> {
    const engine = this.engine()
    if (engine === undefined) return { action: 'compact', changed: false, detail: this.available().reason ?? 'compaction is unavailable' }
    const result = await engine.compactNow(agent, signal)
    if (result === null || result === undefined) {
      // A null here is a real answer: nothing could be safely compacted, which is
      // different from "already compact" and must not be reported as success.
      return { action: 'compact', changed: false, detail: 'the engine found no span it could safely replace' }
    }
    return {
      action: 'compact',
      changed: true,
      ...(result.compactionId === undefined ? {} : { compactionId: result.compactionId }),
      ...(result.shadowedRange === undefined ? {} : { shadowedRange: result.shadowedRange }),
      detail: 'history was summarized in place; the replaced span is recoverable from the session log',
    }
  }

  /**
   * Snip a span, given either explicit surface seqs or a number of recent turns.
   *
   * With `keepRecentTurns`, the boundary is computed from the session's own
   * events: the span to replace ends just before the nth most recent assistant
   * message. The engine still validates balance (a tool call must stay paired
   * with its result), and an unbalanced boundary is its error to raise — this
   * module deliberately does not guess a different range, because guessing would
   * silently discard more than the caller asked for.
   *
   * The schema tells the caller each endpoint is for when it *knows* that one,
   * so a lone `start` is a request and not a typo: the boundary supplies the end
   * it can derive and the caller's half is passed through untouched. Reading an
   * endpoint as "unknown unless both are given" discarded the caller's value and
   * replaced the span it asked for with a wider one — the one direction of error
   * that loses history, and the one this tool exists to let a model *choose*.
   * A pair that ends before it starts is the engine's to refuse, like every other
   * unbalanced boundary.
   */
  async snip(agent: ContextControlAgent, input: { readonly start?: number; readonly end?: number; readonly keepRecentTurns?: number }, signal: AbortSignal): Promise<ContextControlResult> {
    const engine = this.engine()
    if (engine === undefined) return { action: 'snip', changed: false, detail: this.available().reason ?? 'compaction is unavailable' }
    let start = input.start
    let end = input.end
    if (start === undefined || end === undefined) {
      const boundary = keepRecentBoundary(agent, input.keepRecentTurns ?? 1)
      if (boundary === undefined) return { action: 'snip', changed: false, detail: 'there is no earlier span to snip yet' }
      start = start ?? boundary.start
      end = end ?? boundary.end
    }
    const result = await engine.compactRegion(start, end, agent, signal)
    return {
      action: 'snip',
      changed: true,
      ...(result.compactionId === undefined ? {} : { compactionId: result.compactionId }),
      ...(result.shadowedRange === undefined ? {} : { shadowedRange: result.shadowedRange }),
      detail: `replaced surface span ${start}..${end} with one summary node`,
    }
  }
}

/**
 * The span to snip when the caller asks to keep the last N assistant messages.
 *
 * Returns the first surface seq and the seq just before the kept tail. Only
 * assistant messages advance the count: a hundred tool results are one step of
 * work, not a hundred turns.
 */
export function keepRecentBoundary(agent: ContextControlAgent, keepRecentTurns: number): { readonly start: number; readonly end: number } | undefined {
  const events = agent.session.snapshotEvents()
  if (events.length === 0) return undefined
  const assistants: number[] = []
  for (const [index, event] of events.entries()) if (event.type === 'assistant/message') assistants.push(index)
  const keep = Math.max(1, Math.trunc(keepRecentTurns))
  const cutIndex = assistants.length - keep
  if (cutIndex <= 0) return undefined
  const cut = assistants[cutIndex]
  if (cut === undefined) return undefined
  const start = events[0]?.seq
  const end = events[cut - 1]?.seq
  if (start === undefined || end === undefined) return undefined
  return { start, end }
}
