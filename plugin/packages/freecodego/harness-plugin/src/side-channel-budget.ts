/**
 * The side-channel budget invariant.
 *
 * Why
 * ---
 * This plugin makes model calls that are not the conversation: the Advisor
 * reviewer, and any future classifier. Each one builds its own prompt, and each
 * one is *supposed* to be smaller than the conversation it is judging.
 *
 * Claude Code states the invariant explicitly for its auto-mode classifier:
 * "the classifier prompt should stay strictly smaller than main-loop context, so
 * auto-compact fires before the classifier overflows." The failure it prevents is
 * nasty precisely because it is misdiagnosed: when a side channel is the largest
 * thing in the session, *it* hits the context limit first, and what the user sees
 * is "the advisor is broken" or "auto mode stopped working" rather than "the
 * context was full" — so the fix (compact) is never tried, and the side channel
 * gets disabled instead.
 *
 * They also measure it unconditionally, even when nothing is wrong, and dump
 * `delta (classifierEst − mainLoop)` alongside the prompts when a call fails. The
 * measurement is cheap and the diagnosis it enables is not otherwise available,
 * so this module measures the same way: every side-channel call records its own
 * prompt footprint, and the ledger answers "which side channel comes closest to
 * the compaction threshold, and by how much".
 *
 * Scope note: this is a *reporting and warning* invariant. It does not compact,
 * throttle, or disable anything — a module that silently degraded a reviewer
 * would trade a visible failure for an invisible one.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/side-channel-budget
 */

import { tokensFromChars } from './token-estimate.ts'

/**
 * Fraction of the compaction threshold a side channel may reach before it is
 * called out.
 *
 * Not 1.0: the point of the margin is to catch the trend while it is still
 * fixable. A channel at 0.8 of the threshold will cross it as the conversation
 * grows, and the crossing is a silent misdiagnosis; a warning at 0.8 is a
 * conversation that can still be compacted in time.
 */
export const SIDE_CHANNEL_WARN_RATIO = 0.8

/**
 * The three sizes an invariant check needs, all already known to the caller.
 *
 * Nothing is measured here: the point of the check is to compare numbers the path
 * already has, and a probe that measured its own path would be the most expensive
 * thing in it.
 */
export interface SideChannelBudgetInput {
  /** Current request pressure of the conversation being judged. */
  readonly mainLoopTokens: number
  /** The pressure at which the conversation is compacted. */
  readonly compactionThresholdTokens: number
  /** This side channel's own prompt size for the call it is about to make. */
  readonly channelTokens: number
}

/**
 * How a side channel stands relative to the compaction threshold.
 *
 * `unknown` is a state rather than a missing value: a channel whose size could not
 * be measured has not passed the check, and calling it `fits` would be the one
 * answer the check exists to avoid.
 */
export type SideChannelBudgetState = 'fits' | 'narrow' | 'exceeds' | 'unknown'

/**
 * The verdict for one side-channel call, with the numbers it was reached from.
 *
 * `detail` names the consequence rather than restating the ratio, because this is
 * what a member is shown when it is about to overflow its own context.
 */
export interface SideChannelBudgetVerdict {
  readonly state: SideChannelBudgetState
  /** Channel minus main loop; positive means the side channel is the larger one. */
  readonly deltaTokens: number
  /** Channel divided by the compaction threshold; `undefined` when it is unknown. */
  readonly ratio?: number | undefined
  /** One line naming the consequence, not just the number. */
  readonly detail: string
}

/**
 * Evaluate one side-channel call against the invariant.
 *
 * `mainLoopTokens` is reported for the delta but is not the yardstick: the
 * invariant is against the *compaction threshold*, because that is the number
 * that decides whether the conversation gets compacted before the channel
 * overflows. Comparing only against the current main-loop size would call a
 * channel safe in exactly the situation that breaks it — a large channel in a
 * session that has not grown yet.
 * @param input - the conversation's pressure, the threshold, and the channel's size.
 * @returns The state, the delta and ratio it was read from, and the consequence.
 */
export function evaluateSideChannelBudget(input: SideChannelBudgetInput): SideChannelBudgetVerdict {
  const threshold = input.compactionThresholdTokens
  const deltaTokens = Math.round(input.channelTokens - input.mainLoopTokens)
  if (!Number.isFinite(threshold) || threshold <= 0 || !Number.isFinite(input.channelTokens) || input.channelTokens < 0) {
    return { state: 'unknown', deltaTokens, detail: 'the compaction threshold or the channel size is unknown, so the invariant cannot be checked' }
  }
  const ratio = input.channelTokens / threshold
  if (ratio >= 1) {
    return {
      state: 'exceeds',
      deltaTokens,
      ratio,
      detail: `this side channel needs ${Math.round(input.channelTokens).toLocaleString('en-US')} tokens, at or above the ${Math.round(threshold).toLocaleString('en-US')}-token compaction threshold: it will hit the context limit before the conversation does, and its failure will look like a broken channel, not a context problem`,
    }
  }
  if (ratio >= SIDE_CHANNEL_WARN_RATIO) {
    return {
      state: 'narrow',
      deltaTokens,
      ratio,
      detail: `this side channel is at ${Math.round(ratio * 100)}% of the compaction threshold; the conversation must be compacted before it grows much further or the channel overflows first`,
    }
  }
  return {
    state: 'fits',
    deltaTokens,
    ratio,
    detail: `this side channel is at ${Math.round(ratio * 100)}% of the compaction threshold (delta vs the conversation: ${deltaTokens >= 0 ? '+' : ''}${deltaTokens.toLocaleString('en-US')} tokens)`,
  }
}

/**
 * One side-channel call that actually happened, as the ledger keeps it.
 *
 * The channel and session are recorded beside the sizes so a warning can name the
 * call it is about — a ratio with no channel attached tells a member nothing about
 * which of its own calls to stop making.
 */
export interface SideChannelObservation extends SideChannelBudgetInput {
  readonly channel: string
  readonly sessionId: string
  readonly at: number
  /** Output tokens this call actually produced, when the call has settled. */
  readonly outputTokens?: number | undefined
}

/**
 * A bounded record of side-channel footprints.
 *
 * Bounded because the alternative is a leak proportional to session length: an
 * advisor call per turn on a long session is thousands of entries, and nothing
 * here needs history beyond "what is the worst channel right now".
 */
export class SideChannelLedger {
  private readonly worstByChannel = new Map<string, SideChannelObservation>()

  constructor(private readonly maxChannels = 12) {}

  /**
   * Record one observation.
   *
   * Keeps the largest footprint per channel rather than the latest: the invariant
   * is a property of the worst case, and a channel that was over the line once
   * will be again, whereas "the last call was small" proves nothing.
   *
   * Insertion order is *use* order, so the bounded map evicts the channel that has
   * gone longest without a call. Recording a smaller footprint therefore still
   * re-inserts the channel it belongs to: the entry stays the worst one seen, but
   * a channel that is called every turn must not leave this map — it is the same
   * map `warnings()` and `totalTokens()` read, so eviction decides whether an
   * active channel is reported at all.
   * @param observation - the call to record, with what it measured.
   * @returns The verdict for this call, as `warnings()` would report it.
   */
  record(observation: SideChannelObservation): SideChannelBudgetVerdict {
    const verdict = evaluateSideChannelBudget(observation)
    const current = this.worstByChannel.get(observation.channel)
    this.worstByChannel.delete(observation.channel)
    this.worstByChannel.set(observation.channel, current === undefined || observation.channelTokens > current.channelTokens ? observation : current)
    while (this.worstByChannel.size > this.maxChannels) {
      const oldest = this.worstByChannel.keys().next()
      if (oldest.done === true) break
      this.worstByChannel.delete(oldest.value)
    }
    return verdict
  }

  /**
   * Worst recorded footprint for a channel.
   * @param channel - the channel name to look up.
   * @returns Its largest recorded observation, or `undefined` when it has none.
   */
  worst(channel: string): SideChannelObservation | undefined {
    return this.worstByChannel.get(channel)
  }

  /**
   * Channels at or past the warning line, worst first.
   *
   * Deliberately excludes `unknown`: a channel whose size could not be measured is
   * not evidence of a problem, and reporting it as one would train the reader to
   * ignore the list.
   * @param compactionThresholdTokens - the threshold to judge the recorded sizes against.
   * @returns The channels at or past the warning line, worst ratio first.
   */
  warnings(compactionThresholdTokens: number): readonly { readonly channel: string; readonly verdict: SideChannelBudgetVerdict }[] {
    const out: { channel: string; verdict: SideChannelBudgetVerdict }[] = []
    for (const [channel, observation] of this.worstByChannel) {
      const verdict = evaluateSideChannelBudget({ ...observation, compactionThresholdTokens })
      if (verdict.state === 'narrow' || verdict.state === 'exceeds') out.push({ channel, verdict })
    }
    return out.sort((left, right) => (right.verdict.ratio ?? 0) - (left.verdict.ratio ?? 0))
  }

  /**
   * Sum of the worst footprint per channel: the session's standing side-channel tax.
   * @returns The total tokens the recorded channels add on every turn.
   */
  totalTokens(): number {
    let total = 0
    for (const observation of this.worstByChannel.values()) total += Math.max(0, observation.channelTokens)
    return total
  }

  /**
   * The channels currently recorded, in use order.
   * @returns Their names, least recently used first.
   */
  channels(): readonly string[] {
    return [...this.worstByChannel.keys()]
  }

  /**
   * Drop one channel's record.
   * @param channel - the channel to forget.
   */
  forget(channel: string): void {
    this.worstByChannel.delete(channel)
  }

  /** Drop every record, for a session that has ended or been compacted away. */
  clear(): void {
    this.worstByChannel.clear()
  }
}

/**
 * Approximate tokens for a prepared side-channel prompt.
 *
 * The ~4-chars-per-token convention the plugin's other spend probes use. Kept
 * here as a documented estimate rather than a tokenizer count, because an
 * invariant check must not be the most expensive thing in the path it checks.
 * @param text - the prepared prompt to estimate.
 * @returns Its approximate token count, at the plugin's documented convention.
 */
export function approximateChannelTokens(text: string): number {
  return tokensFromChars(text.length)
}
