/**
 * Manual context control: compact now, and snip a chosen span.
 *
 * Compaction in the Harness is trigger-driven — pressure, or a provider's
 * context-overflow report — and the automatic pruner and compactor ship disabled.
 * That leaves the one case a model is best at noticing uncovered: it knows it has
 * finished with the 200 lines of type definitions it read twenty steps ago, and it
 * can say so long before a pressure threshold agrees.
 *
 * This module exposes that as two decisions rather than one knob:
 *
 * - **compact now** summarizes useful history below the automatic threshold, which
 *   is the `/compact` a person would run.
 * - **snip** replaces a chosen span with one summary node, which is how a model
 *   drops a region it has already extracted what it needs from.
 *
 * Why the engine is looked up per session, not on the Host
 * --------------------------------------------------------
 * A deployment can mount compaction on the Host plane or inside the agent
 * preset, and the Web app does the second: its patch disables the `compaction-basic`
 * and `command-compact` host rows, and the shipped preset mounts both again under
 * a group that declares `isolate: { compaction: true }`. That realm is invisible
 * from outside — **including to the Host** — so a lookup on the plugin's own
 * context finds nothing while the engine is mounted in the very session the caller
 * is asking about, and the honest-looking answer ("no engine is mounted") is then
 * wrong about the deployment it is describing.
 *
 * The three lookup tiers follow that reality, most specific first:
 *
 * 1. **the session's preset**, through the preset roster's own accessor —
 *    `agentPresets.serviceFor(agent, 'compaction')`, which is the documented way a
 *    caller holding an agent reads a service out of that realm.
 * 2. **the agent's scope**, for a composition that hands the engine to the agent
 *    without a preset.
 * 3. **the Host**, for one that mounts it globally (a CLI profile keeps the base
 *    rows the Web app disables).
 *
 * {@link ContextControl.available} names which tier answered: "unavailable" and
 * "unavailable *at this scope*" are different facts about a deployment, and only
 * one of them is worth acting on.
 *
 * The engine is optional by design and resolved per call. A composition without
 * one must still load and must say so rather than failing a tool call that looked
 * available, and a service captured at construction would keep answering for a
 * realm that is gone.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/context-control
 */

import type { Context } from '@deepseek-ai/cordis'
import { JSON_TOOL_OUTPUT, toolDefinition, type ToolDefinitionShape } from './tool-definition.ts'

/**
 * Structural view of the compaction seam — only the parts this module calls.
 *
 * Declared here rather than imported from `@deepseek-ai/dsh-compaction`: the
 * service is reached through `ctx.get('compaction')`, so the type has to describe
 * what an engine *does* at that seam. An import would also add a dependency edge
 * this plugin does not otherwise have, for two method signatures.
 */
interface CompactionEngineLike {
  compactNow(agent: unknown, signal: AbortSignal, sourceCommandId?: string): Promise<CompactionResultLike | null>
  compactRegion(start: number, end: number, agent: unknown, signal?: AbortSignal): Promise<CompactionResultLike>
}

/** The fields of a compaction result this module reports, all optional to read. */
interface CompactionResultLike {
  readonly compactionId?: unknown
  readonly summarySeq?: unknown
  readonly shadowedRange?: unknown
  readonly shadowedSeqs?: unknown
  readonly shadowedTokenCount?: unknown
}

/** Which scope the engine came from, most session-specific first. */
export type ContextControlScope = 'preset' | 'agent' | 'host'

/**
 * What a context-control call did, in terms a caller can report and act on.
 *
 * `changed: false` carries a `detail` saying why rather than throwing: "nothing
 * could be safely replaced" and "the engine is not mounted" are both answers a
 * caller can relay, and neither should end a turn as an error.
 */
export interface ContextControlResult {
  readonly action: 'compact' | 'snip'
  readonly changed: boolean
  /** The scope whose engine answered, when one did. */
  readonly scope?: ContextControlScope
  readonly compactionId?: string
  /** Inclusive surface-position span that was replaced, when the engine reported one. */
  readonly shadowedRange?: { readonly start: number; readonly end: number }
  /** How many surface nodes were shadowed, when the engine reported the set. */
  readonly shadowedNodes?: number
  /** Estimated tokens the replaced content held, when the engine reports it. */
  readonly shadowedTokens?: number
  readonly detail: string
}

/** Everything this module needs from an agent, and nothing else. */
export interface ContextControlAgent {
  /**
   * The agent-scoped context. The preset that mounts compaction hands the agent
   * this scope, so it is where the engine is found; absent means the caller's own
   * scope cannot be asked and only the Host lookup remains.
   */
  readonly ctx?: { get(name: string): unknown } | undefined
  readonly session: {
    readonly seq?: number
    snapshotEvents(): readonly { readonly seq: number; readonly type: string }[]
  }
}

/**
 * The engine's expected failures, as codes rather than as classes.
 *
 * Read structurally for the same reason the seam is: an engine implementation
 * raises these through its own error class, and a plugin that had to import that
 * class would refuse to work with a different engine. `busy` and `cancelled` are
 * the two a caller hits most: the first because a compaction was already running
 * or the agent was mid-turn, the second because the request was aborted.
 */
const ENGINE_FAILURE_TEXT: Readonly<Record<string, string>> = {
  busy: 'the session already has an active compaction, or the agent is not idle',
  cancelled: 'the compaction was cancelled',
  changed: 'the history selected for compaction changed before it could be replaced',
  summary: 'the engine could not produce a useful summary',
  commit: 'the compaction did not finish cleanly; some history may have changed',
  persistence: 'the compaction finished, but the session could not be saved',
}

/** The engine's own reason for refusing, when it named one this module knows. */
function describeEngineFailure(error: unknown): string | undefined {
  const code = (error as { readonly code?: unknown } | null | undefined)?.code
  return typeof code === 'string' ? ENGINE_FAILURE_TEXT[code] : undefined
}

/**
 * Context maintenance the caller can ask for on its own conversation.
 *
 * Every call degrades to a `changed: false` result with a reason for the failures
 * the engine is *expected* to raise, and rethrows anything else: an unexpected
 * error is a bug in the engine or in this module, and a tool answer that swallowed
 * it would hide it behind a sentence about context.
 */
export class ContextControl {
  constructor(private readonly host: Context) {}

  /**
   * The seam this caller can reach, and which scope it came from.
   *
   * Session-specific first, Host last — see the module header for why that order
   * is the whole point rather than a preference.
   * @param agent - the conversation the request is about.
   * @returns the engine and its scope, or `undefined` when no scope has one.
   */
  private engineFor(agent: ContextControlAgent): { readonly engine: CompactionEngineLike; readonly scope: ContextControlScope } | undefined {
    const candidates: readonly (readonly [ContextControlScope, unknown])[] = [
      ['preset', presetService(this.host, agent)],
      ['agent', lookup(agent.ctx, 'compaction')],
      ['host', lookup(this.host, 'compaction')],
    ]
    for (const [scope, service] of candidates) {
      if (service === null || typeof service !== 'object') continue
      const engine = service as Partial<CompactionEngineLike>
      if (typeof engine.compactNow === 'function' && typeof engine.compactRegion === 'function') {
        return { engine: engine as CompactionEngineLike, scope }
      }
    }
    return undefined
  }

  /**
   * Whether context maintenance can run for this caller at all.
   * @param agent - the conversation the question is about.
   * @returns `ok: false` with a reason when neither scope mounted an engine.
   */
  available(agent: ContextControlAgent): { readonly ok: boolean; readonly scope?: ContextControlScope; readonly reason?: string } {
    const found = this.engineFor(agent)
    if (found === undefined) {
      return {
        ok: false,
        reason: 'no compaction engine is mounted where this session can reach it — neither its own agent preset, nor its agent scope, nor the Host composition; the preset has to mount the same service `/compact` uses, or run `/compact` directly',
      }
    }
    return { ok: true, scope: found.scope }
  }

  /**
   * Summarize useful history now, below the automatic pressure threshold.
   *
   * The engine's `null` is reported as `changed: false` rather than success,
   * because "no span could be safely replaced" is a different answer from "there
   * was nothing to do" and a caller that conflated them would report room it never
   * made.
   * @param agent - the conversation to compact.
   * @param signal - aborts the request when the caller cancels.
   * @returns What the engine replaced, or why nothing was replaced.
   */
  async compactNow(agent: ContextControlAgent, signal: AbortSignal): Promise<ContextControlResult> {
    const found = this.engineFor(agent)
    if (found === undefined) return { action: 'compact', changed: false, detail: this.available(agent).reason ?? 'compaction is unavailable' }
    try {
      const result = await found.engine.compactNow(agent, signal)
      if (result === null || result === undefined) {
        // A null here is a real answer: nothing could be safely compacted, which is
        // different from "already compact" and must not be reported as success.
        return { action: 'compact', changed: false, scope: found.scope, detail: 'the engine found no span it could safely replace' }
      }
      return {
        action: 'compact',
        changed: true,
        scope: found.scope,
        ...projection(result),
        detail: `history was summarized in place${describeShadowed(result)}; the replaced span is recoverable from the session log`,
      }
    } catch (error) {
      return { action: 'compact', changed: false, scope: found.scope, detail: refusal(error, signal, 'compact') }
    }
  }

  /**
   * Snip a span, given either explicit surface positions or a number of recent turns.
   *
   * With `keepRecentTurns`, the boundary is computed from the session's own events:
   * the span to replace ends just before the nth most recent assistant message. The
   * engine still validates balance — a tool call must stay paired with its result —
   * and an unbalanced boundary is its error to raise. This module deliberately does
   * not guess a different range, because guessing would silently discard more than
   * the caller asked for.
   *
   * The schema tells the caller each endpoint is for when it *knows* that one, so a
   * lone `start` is a request and not a typo: the caller's half is passed through
   * untouched and the boundary supplies only the end it can derive. Treating an
   * endpoint as unknown unless both are given would replace a span the caller did
   * not name — the one direction of error that loses history the caller meant to
   * keep, and the one this tool exists to let a model *choose*.
   * A pair that ends before it starts is the engine's to refuse, like every other
   * unbalanced boundary.
   * @param agent - the conversation to snip.
   * @param input - the span to replace, or how many recent turns to keep.
   * @param signal - aborts the request when the caller cancels.
   * @returns What the engine replaced, or why nothing was replaced.
   */
  async snip(
    agent: ContextControlAgent,
    input: { readonly start?: number; readonly end?: number; readonly keepRecentTurns?: number },
    signal: AbortSignal,
  ): Promise<ContextControlResult> {
    const found = this.engineFor(agent)
    if (found === undefined) return { action: 'snip', changed: false, detail: this.available(agent).reason ?? 'compaction is unavailable' }
    let start = input.start
    let end = input.end
    if (start === undefined || end === undefined) {
      const boundary = keepRecentBoundary(agent, input.keepRecentTurns ?? 1)
      if (boundary === undefined) return { action: 'snip', changed: false, scope: found.scope, detail: 'there is no earlier span to snip yet' }
      start = start ?? boundary.start
      end = end ?? boundary.end
    }
    try {
      const result = await found.engine.compactRegion(start, end, agent, signal)
      return {
        action: 'snip',
        changed: true,
        scope: found.scope,
        ...projection(result),
        detail: `replaced surface span ${String(start)}..${String(end)} with one summary node${describeShadowed(result)}`,
      }
    } catch (error) {
      return { action: 'snip', changed: false, scope: found.scope, detail: refusal(error, signal, 'snip') }
    }
  }
}

/**
 * The engine the session's own preset mounted, which no host lookup can see.
 *
 * Read through `agentPresets.serviceFor` rather than off `agent.ctx`: a preset
 * publishes its `isolate` realm's services to the group that declares them, so the
 * accessor is the only supported way in from outside — which is exactly what this
 * is, a request about a session that arrives from a tool call.
 *
 * Absent when the composition has no preset roster (a raw or CLI profile), when
 * the caller is not inside a mounted preset, or when the accessor itself throws.
 */
function presetService(host: unknown, agent: ContextControlAgent): unknown {
  if (agent.ctx === undefined) return undefined
  const presets = lookup(host, 'agentPresets')
  const serviceFor = (presets as { readonly serviceFor?: unknown } | undefined)?.serviceFor
  if (typeof serviceFor !== 'function') return undefined
  try {
    return (serviceFor as (target: unknown, name: string) => unknown).call(presets, agent, 'compaction')
  } catch {
    return undefined
  }
}

/** Read one service off a context, treating a missing or throwing scope as absent. */
function lookup(context: unknown, name: string): unknown {
  if (context === null || context === undefined) return undefined
  try {
    const get = (context as { readonly get?: unknown }).get
    if (typeof get !== 'function') return undefined
    const service = (get as (serviceName: string) => unknown).call(context, name)
    return service === null || typeof service !== 'object' ? undefined : service
  } catch {
    return undefined
  }
}

/** The reportable fields of a compaction result, read defensively. */
function projection(result: CompactionResultLike): Pick<ContextControlResult, 'compactionId' | 'shadowedRange' | 'shadowedNodes' | 'shadowedTokens'> {
  const range = result.shadowedRange as { readonly start?: unknown; readonly end?: unknown } | null | undefined
  const seqs = result.shadowedSeqs
  return {
    ...(typeof result.compactionId === 'string' ? { compactionId: result.compactionId } : {}),
    ...(typeof range?.start === 'number' && typeof range.end === 'number' ? { shadowedRange: { start: range.start, end: range.end } } : {}),
    ...(Array.isArray(seqs) ? { shadowedNodes: seqs.length } : {}),
    ...(typeof result.shadowedTokenCount === 'number' ? { shadowedTokens: result.shadowedTokenCount } : {}),
  }
}

/** `and N items (~M tokens)` when the engine counted them, else nothing. */
function describeShadowed(result: CompactionResultLike): string {
  const nodes = Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs.length : 0
  const tokens = typeof result.shadowedTokenCount === 'number' ? result.shadowedTokenCount : undefined
  if (nodes === 0) return ''
  return ` (${String(nodes)} items${tokens === undefined ? '' : `, ~${String(tokens)} tokens`})`
}

/**
 * One engine failure, as the sentence the caller reads.
 *
 * A cancellation is answered before the error is inspected: an aborted request
 * fails with whatever reason the abort carried, and reporting that reason as the
 * engine's own refusal would name the wrong cause.
 */
function refusal(error: unknown, signal: AbortSignal, action: 'compact' | 'snip'): string {
  if (signal.aborted) return `the ${action} request was cancelled`
  const described = describeEngineFailure(error)
  if (described !== undefined) return described
  throw error
}

/**
 * The span to snip when the caller asks to keep the last N assistant messages.
 *
 * Returns the first surface seq and the seq just before the kept tail. Only
 * assistant messages advance the count: a hundred tool results are one step of
 * work, not a hundred turns.
 * @param agent - the conversation whose own events the boundary is computed from.
 * @param keepRecentTurns - how many recent assistant messages to leave in place.
 * @returns The inclusive surface-span to replace, or `undefined` when keeping the
 * tail would leave nothing to snip.
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

/** The agent a tool call belongs to, or a refusal naming what was missing. */
function agentOf(exec: unknown): ContextControlAgent {
  const agent = (exec as { readonly agent?: unknown } | undefined)?.agent
  if (agent === null || typeof agent !== 'object') throw new Error('context control needs an active agent: this tool acts on the conversation it is called from')
  const session = (agent as { readonly session?: unknown }).session
  if (session === null || typeof session !== 'object' || typeof (session as { snapshotEvents?: unknown }).snapshotEvents !== 'function') {
    throw new Error('context control needs an active agent: this tool acts on the conversation it is called from')
  }
  return agent as ContextControlAgent
}

/** The call's cancellation signal, or one that never aborts. */
function signalOf(exec: unknown): AbortSignal {
  const signal = (exec as { readonly signal?: unknown } | undefined)?.signal
  return signal instanceof AbortSignal ? signal : new AbortController().signal
}

/**
 * The two context-control tools, as definitions the registry accepts.
 *
 * Definitions rather than registrations: the Host registers them, so this module
 * stays a pure description of the capability and can be driven from a test without
 * a plugin context.
 * @param control - the runtime the definitions call.
 * @returns Both definitions, in the order the model sees them.
 */
export function contextControlToolDefinitions(control: ContextControl): readonly ToolDefinitionShape[] {
  return [
    toolDefinition({
      name: 'engineering_context_compact',
      description: 'Summarize useful history now, without waiting for the context-pressure threshold. Call it after finishing a phase whose details no longer matter: the replaced span is summarized in place and stays recoverable from the session log. It returns changed:false when the engine found nothing safe to replace, which is an answer, not a failure.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: JSON_TOOL_OUTPUT,
      execute: async (_args: unknown, exec: unknown) => await control.compactNow(agentOf(exec), signalOf(exec)),
      presentCall: () => ({ card: 'generic', title: 'Compact context now' }),
    }),
    toolDefinition({
      name: 'engineering_context_snip',
      description: 'Replace an old span of this conversation with one summary node, keeping the most recent turns. Use it to drop a region you have already extracted what you need from. The engine validates that the span keeps tool calls paired with their results and will refuse rather than over-delete, so an unbalanced boundary is an error, not a silently larger cut.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          keep_recent_turns: { type: 'integer', minimum: 1, maximum: 20, description: 'How many recent assistant turns to keep. Defaults to 1.' },
          start: { type: 'integer', description: 'First surface seq to replace, when you know it.' },
          end: { type: 'integer', description: 'Last surface seq to replace, when you know it.' },
        },
      },
      output: JSON_TOOL_OUTPUT,
      execute: async (args: { readonly keep_recent_turns?: number; readonly start?: number; readonly end?: number }, exec: unknown) => await control.snip(
        agentOf(exec),
        {
          ...(args.keep_recent_turns === undefined ? {} : { keepRecentTurns: args.keep_recent_turns }),
          ...(args.start === undefined ? {} : { start: args.start }),
          ...(args.end === undefined ? {} : { end: args.end }),
        },
        signalOf(exec),
      ),
      presentCall: (args: { readonly keep_recent_turns?: number }) => ({ card: 'generic', title: `Snip context (keep ${String(args.keep_recent_turns ?? 1)})` }),
    }),
  ]
}
