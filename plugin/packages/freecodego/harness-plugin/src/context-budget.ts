/**
 * The model-visible context budget.
 *
 * Why
 * ---
 * Our spend probes found that compaction never runs in practice and that the
 * model has no idea how full its own context is. Both failures have the same
 * shape: the decision to compact (or to stop reading whole files) is made by a
 * threshold the *engine* watches, and the party that could avoid the cost —
 * the model — is never told the number. Codex closes this with a
 * `<rollout_budget>`-style fragment and a `get_context_remaining` tool.
 *
 * The hard part is not computing the number, it is injecting it without
 * destroying the cache the number is about. A budget fragment that changes on
 * every turn rewrites the request prefix on every turn, which re-bills the whole
 * conversation at full price — the exact failure Claude Code's own source
 * records (~10.2% of their fleet cache-creation tokens) for a dynamic agent
 * list. So the injected text is **quantized into bands**: it is identical for
 * as long as the session stays inside one band, and the engine's diff sends a
 * replacement notice only when a band is crossed. Precision on demand goes in
 * `engineering_context_budget`, whose schema is deferred and which therefore
 * costs nothing until the model asks.
 *
 * Three honesty rules, because a budget the model cannot trust is worse than no
 * budget:
 *
 * 1. **Estimated is not measured.** The token-meter's own baseline is either
 *    provider usage or a heuristic. A heuristic boundary is labelled as a rough
 *    figure; a model told "4,000 tokens left" when that is a guess will make
 *    real decisions on a fake number.
 * 2. **An unknown window is stated as unknown.** When the routed model does not
 *    advertise a context window we report the used figure and say the window is
 *    not advertised, rather than inventing a denominator.
 * 3. **No prescriptive threshold in the fragment.** The band names a condition
 *    and the remedies that apply to it; it does not order an action at a
 *    specific token count, because the model sees the truth more cheaply than
 *    we can guess at it.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/context-budget
 */

/** Coarse pressure bands, ordered from least to most constrained. */
export type ContextBand = 'ample' | 'comfortable' | 'tight' | 'critical' | 'over' | 'unknown'

/**
 * Band boundaries as a fraction of the usable window.
 *
 * Four boundaries, not a slider: every additional boundary is another chance for
 * the prefix to change mid-conversation, and the remedies do not get more
 * specific than this.
 */
export const CONTEXT_BAND_AT: Readonly<Record<Exclude<ContextBand, 'unknown'>, number>> = {
  ample: 0,
  comfortable: 0.35,
  tight: 0.6,
  critical: 0.8,
  over: 1,
}

/**
 * What the budget report is computed from.
 *
 * `measured` travels with the figures rather than being decided at render time,
 * because a heuristic price that is presented as provider usage is the one claim
 * this surface must not make.
 */
export interface ContextBudgetInput {
  /** Current request pressure in tokens, as the token-meter measured it. */
  readonly usedTokens: number
  /** The routed model's advertised window; `undefined` when it advertises none. */
  readonly contextWindow?: number | undefined
  /**
   * Whether `usedTokens` came from provider usage or a heuristic price. Carried
   * into the rendered text so a heuristic is never presented as a measurement.
   */
  readonly measured: boolean
  /** Tokens the reply needs, subtracted from what is left. */
  readonly responseReserve?: number | undefined
}

/**
 * One session's context budget, as the fragment, the status line and the band
 * memory all read it.
 *
 * `band` is derived here rather than by each caller, so the text a model is shown
 * and the band the store remembers cannot be computed from different numbers.
 */
export interface ContextBudgetReport {
  readonly usedTokens: number
  readonly contextWindow?: number | undefined
  readonly responseReserve: number
  /** Window minus used minus reserve; `undefined` when the window is unknown. */
  readonly remainingTokens?: number | undefined
  /** Used divided by the window; `undefined` when the window is unknown. */
  readonly usedFraction?: number | undefined
  readonly band: ContextBand
  readonly measured: boolean
}

/**
 * Classify pressure into a band.
 *
 * The comparison uses the *remaining* room after the response reserve, because a
 * window 90% full with a large reply still to come is tighter than the same
 * window with a short one.
 * @param usedTokens - current request pressure in tokens.
 * @param contextWindow - the routed model's advertised window, when it advertises one.
 * @param responseReserve - tokens the reply needs, taken out of the usable room.
 * @returns The band, or `unknown` when no usable window is known.
 */
export function classifyContextPressure(usedTokens: number, contextWindow: number | undefined, responseReserve = 0): ContextBand {
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) return 'unknown'
  const usable = Math.max(1, contextWindow - Math.max(0, responseReserve))
  const fraction = Math.max(0, usedTokens) / usable
  if (fraction >= CONTEXT_BAND_AT.over) return 'over'
  if (fraction >= CONTEXT_BAND_AT.critical) return 'critical'
  if (fraction >= CONTEXT_BAND_AT.tight) return 'tight'
  if (fraction >= CONTEXT_BAND_AT.comfortable) return 'comfortable'
  return 'ample'
}

/**
 * Compute one session's budget report.
 *
 * The reserve is clamped to the room that exists, so a session already past its
 * window is not reported as over by the overrun *plus* the reply it planned: the
 * shortfall is the same number whether or not a reply was reserved for.
 * @param input - the measured pressure and the window it is measured against.
 * @returns The figures, the band, and whether they came from provider usage.
 */
export function contextBudgetReport(input: ContextBudgetInput): ContextBudgetReport {
  const usedTokens = Math.max(0, Math.round(input.usedTokens))
  const responseReserve = Math.max(0, Math.round(input.responseReserve ?? 0))
  const contextWindow = input.contextWindow !== undefined && Number.isFinite(input.contextWindow) && input.contextWindow > 0
    ? Math.round(input.contextWindow)
    : undefined
  // The reserve is only taken out of room that exists. Subtracting it from a
  // session already past its window would report the overrun *plus* the reserve
  // as the shortfall, double-counting the same tokens: a 150k request against a
  // 100k window is 50k over whether or not a 20k reply was planned, and the
  // remaining figure has to say 50k.
  const effectiveReserve = contextWindow === undefined
    ? responseReserve
    : Math.min(responseReserve, contextWindow, Math.max(0, contextWindow - usedTokens))
  const remainingTokens = contextWindow === undefined ? undefined : contextWindow - usedTokens - effectiveReserve
  return {
    usedTokens,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    responseReserve: effectiveReserve,
    ...(remainingTokens === undefined ? {} : { remainingTokens }),
    ...(contextWindow === undefined ? {} : { usedFraction: usedTokens / contextWindow }),
    band: classifyContextPressure(usedTokens, contextWindow, effectiveReserve),
    measured: input.measured,
  }
}

const percent = (fraction: number): string => `${Math.round(fraction * 100)}%`

/** Thousands-separated counts; a bare 148213 is unreadable at a glance. */
const count = (value: number): string => Math.round(value).toLocaleString('en-US')

/** The remedy for a band, stated as an option rather than an order. */
function remedyFor(band: ContextBand): string {
  switch (band) {
    case 'over':
      return 'There is no room for another turn at this size. Compact or snip the conversation before continuing, or the next request will fail.'
    case 'critical':
      return 'A large read or a long reply will not fit. Prefer a targeted read over a whole file, and compact or snip before starting work that needs many turns.'
    case 'tight':
      return 'Read selectively rather than whole files, and keep replies short. Compacting or snipping now costs less than compacting later.'
    case 'comfortable':
      return 'No action needed; this is reported so the figure never appears for the first time when it is already too late.'
    case 'ample':
      return 'No action needed.'
    case 'unknown':
      return 'The window is not advertised for the routed model, so no fraction can be given; treat the used figure as a lower bound only.'
  }
}

/**
 * The line that makes a repeated fragment honest.
 *
 * The fragment is *appended* to the conversation, so every band crossing leaves
 * another figure behind. Without this line the model holds a stale number and a
 * fresh one and nothing that says which to act on — the case the fragment engine
 * solves with `replacementNotice`, and the one that decides whether a budget
 * fragment is trustworthy at all.
 */
export const CONTEXT_BUDGET_REPLACEMENT_NOTICE = 'This context-budget figure replaces the one reported earlier in this conversation; it is the one to act on.'

/**
 * Render the model-facing fragment.
 *
 * Kept to a fixed shape so that crossing a band changes as few bytes as
 * possible, and so the text never names a threshold the model should obey
 * mechanically.
 * @param report - the budget to render.
 * @param options - whether this fragment replaces one the session already saw.
 * @returns The lines injected into the conversation, remedy included.
 */
export function contextBudgetFragment(report: ContextBudgetReport, options: { readonly replaces?: boolean } = {}): string {
  const lines = [`Context budget (${report.band}): ${count(report.usedTokens)} tokens in use${report.measured ? '' : ' (heuristic estimate, not provider usage)'}.`]
  if (report.contextWindow !== undefined && report.remainingTokens !== undefined && report.usedFraction !== undefined) {
    lines.push(`Window ${count(report.contextWindow)} tokens, ${percent(report.usedFraction)} used, ${count(Math.max(0, report.remainingTokens))} left after reserving ${count(report.responseReserve)} for the reply.`)
  }
  lines.push(remedyFor(report.band))
  if (options.replaces === true) lines.unshift(CONTEXT_BUDGET_REPLACEMENT_NOTICE)
  return lines.join('\n')
}

/**
 * One line for a tool result or a settings readout.
 *
 * Same numbers as the fragment, no remedy text: a report is for a reader who is
 * deciding, not for a model that has to act inside the turn.
 * @param report - the budget to describe.
 * @returns One line naming the figures, the band, and that no window was advertised.
 */
export function describeContextBudget(report: ContextBudgetReport): string {
  const usage = `${count(report.usedTokens)} tokens used${report.measured ? '' : ' (estimated)'}`
  if (report.contextWindow === undefined || report.remainingTokens === undefined || report.usedFraction === undefined) {
    return `${usage}; the routed model advertises no context window, so no remaining figure is available`
  }
  return `${usage} of ${count(report.contextWindow)} (${percent(report.usedFraction)}), ${count(Math.max(0, report.remainingTokens))} remaining after a ${count(report.responseReserve)}-token reply reserve — ${report.band}`
}

/**
 * What the fragment engine should do with this session's budget right now.
 *
 * `changed` is what suppresses the injection entirely: the fragment is rebuilt only
 * when a band is crossed, which is what keeps the injected prefix stable and the
 * cache prefix with it.
 */
export interface BudgetPlan {
  /** Whether the injected fragment differs from what this session last received. */
  readonly changed: boolean
  readonly band: ContextBand
  readonly text: string
}

/**
 * Per-session band memory, so the fragment changes only when a band is crossed.
 *
 * Deliberately not durable: a restart re-announces the current band once, which
 * is the same thing the fragment engine already does for every section whose
 * previous state is unknown.
 */
export class ContextBudgetStore {
  private readonly bands = new Map<string, ContextBand>()

  /**
   * Band last injected for a session, or `undefined` if it has never been told.
   * @param sessionId - the Harness session this operation acts on.
   * @returns The band last committed for it, or `undefined` when none was.
   */
  bandFor(sessionId: string): ContextBand | undefined {
    return this.bands.get(sessionId)
  }

  /**
   * Decide whether to inject.
   *
   * `commit()` is separate so a caller that measures but does not send (an
   * aborted turn, a session whose fragment was suppressed) does not desynchronize
   * the store from what the model was actually shown.
   * @param sessionId - the Harness session this operation acts on.
   * @param report - the budget just measured for that session.
   * @returns Whether the band changed, and the text to inject when it did.
   */
  plan(sessionId: string, report: ContextBudgetReport): BudgetPlan {
    const band = report.band
    const previous = this.bands.get(sessionId)
    // A session this store has already told is told *again* — with the notice
    // that says which figure counts. Today's caller appends, so a bare second
    // fragment would leave the model to guess.
    return {
      changed: previous !== band,
      band,
      text: contextBudgetFragment(report, { replaces: previous !== undefined && previous !== band }),
    }
  }

  /**
   * Remember the band that was actually injected.
   * @param sessionId - the Harness session this operation acts on.
   * @param band - the band its fragment announced.
   */
  commit(sessionId: string, band: ContextBand): void {
    this.bands.set(sessionId, band)
  }

  /**
   * Forget a session's band, so its next fragment is announced in full.
   * @param sessionId - the session that ended or was compacted away.
   */
  forget(sessionId: string): void {
    this.bands.delete(sessionId)
  }

  /** Drop every remembered band, for a Host whose sessions are all gone. */
  clear(): void {
    this.bands.clear()
  }
}
