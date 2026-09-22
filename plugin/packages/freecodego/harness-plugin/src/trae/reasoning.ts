/**
 * The SOLO think-effort control.
 *
 * Where the setting lives when the wire has nowhere to put it
 * ----------------------------------------------------------
 * SOLO's conversation body states no reasoning field at all — not an effort
 * tier, not a token budget, not a boolean. What the upstream does read is the
 * system prompt, so the only honest place to steer thinking is the prompt
 * itself: each level is a fixed sentence prepended to the system message.
 *
 * That is measured, not assumed. The levels below are the ones a sibling
 * implementation of this same protocol probed on real SOLO configurations
 * (2026-07-23 notes): a short `Reasoning Effort: High` label is what moves GLM
 * and Qwen, DeepSeek only responded to the long "absolute maximum" wording, and
 * Kimi was the one family that also answered a *shortening* instruction. Those
 * wordings are carried here verbatim, because a paraphrase is a different
 * experiment, and the whole value of the table is that someone already ran it.
 *
 * What that means for the menu
 * ----------------------------
 * A family that was never probed gets no menu rather than a plausible-looking
 * one: {@link traeReasoningEffortsFor} returns `undefined` for it, and the
 * picker then shows no thinking control for that route — which is the truth,
 * since nothing this connector sends would change how it thinks. Widening the
 * table is a question for a probe, not for a guess.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/trae/reasoning
 */

/** The system-prompt block is fenced so an injected prompt is recognizable. */
const MARKER_START = '<<think_effort>>\n'
const MARKER_END = '\n<</think_effort>>\n\n'

/** Wraps a level's sentence in the fence; the markers themselves are inert. */
const MARKER_PATTERN = /<<think_effort>>[\s\S]*?<<\/think_effort>>\n*/gu

/**
 * DeepSeek's wording, and Kimi's deepening level: the long form.
 *
 * A short "Max" label did not move DeepSeek at all in the probes, while this
 * one did, which is why the level is not spelled with the short string below.
 */
const PREFIX_MAX_ABSOLUTE =
  'Reasoning Effort: Absolute maximum with no shortcuts permitted. '
  + 'You MUST be very thorough in your thinking and comprehensively decompose the problem '
  + 'to resolve the root cause, rigorously stress-testing your logic against all potential paths, '
  + 'edge cases, and adversarial scenarios. Explicitly write out your entire deliberation process, '
  + 'documenting every intermediate step, considered alternative, and rejected hypothesis to ensure '
  + 'absolutely no assumption is left unchecked.\n\n'

/** The short Max label, used where the long form hurts (GLM) or is not needed. */
const PREFIX_MAX = 'Reasoning Effort: Max\n\n'

/** The short High label. */
const PREFIX_HIGH = 'Reasoning Effort: High\n\n'

/** Kimi's shortening level: the one probe that produced *less* thinking. */
const PREFIX_KIMI_LOW =
  '<critical_constraints>\n'
  + 'Reasoning Mode: Token-efficient and concise.\n'
  + 'Rush through reasoning, be as concise as possible. Full send; never draft.\n'
  + 'Do NOT use progressive refinement or iterative self-criticism loops.\n'
  + 'You are allowed a maximum of one draft before outputting the final response.\n'
  + 'BAN all moralizing, conjecture, and assumption about actions or motives. Stick to the facts.\n'
  + '</critical_constraints>\n\n'

/**
 * Every level the connector can ask for, in the order the menu shows them.
 *
 * `off` is not "stop thinking": SOLO cannot be told that. It is the level that
 * sends nothing at all, leaving the model its own default — which is also the
 * level a session that never touched the control is on.
 */
export const TRAE_REASONING_EFFORTS = ['off', 'low', 'high', 'max'] as const

/** One selectable think-effort level. */
export type TraeReasoningEffort = typeof TRAE_REASONING_EFFORTS[number]

interface TraeReasoningFamily {
  readonly id: string
  /** Whether this model names the family; the argument is a `config_name`. */
  readonly matches: (model: string) => boolean
  /** The levels this family has a probed wording for. */
  readonly levels: Partial<Record<TraeReasoningEffort, string>>
}

/**
 * The probed families.
 *
 * The matchers are wider than the sibling implementation's exact-name lists in
 * one direction only: they also accept the same family reached through a route
 * prefix (`free/glm-5.3-flash`) or a neighbouring version (`glm-5.3-flash`),
 * because the injection is a prompt sentence and the family is what it speaks
 * to. They are never wider than the family.
 */
const TRAE_REASONING_FAMILIES: readonly TraeReasoningFamily[] = [
  {
    id: 'glm',
    matches: model => model.includes('glm-5'),
    // High *shortens* GLM's own reasoning, and Max uses the short label: the
    // long "absolute maximum" wording measurably hurt this family.
    levels: { high: PREFIX_HIGH, max: PREFIX_MAX },
  },
  {
    id: 'deepseek',
    matches: model => /^deepseek-v4-(pro|flash)(-official)?$/iu.test(model),
    levels: { max: PREFIX_MAX_ABSOLUTE },
  },
  {
    id: 'qwen',
    matches: model => /^qwen/u.test(model),
    levels: { high: PREFIX_HIGH, max: PREFIX_MAX },
  },
  {
    id: 'kimi',
    matches: model => model.includes('kimi-k'),
    levels: { low: PREFIX_KIMI_LOW, high: PREFIX_HIGH, max: PREFIX_MAX_ABSOLUTE },
  },
]

/**
 * The family a configuration belongs to, when it has a probed one.
 * @param model - the `config_name` a request states.
 * @returns the family, or `undefined` when no wording was ever measured for it.
 */
export function traeReasoningFamily(model: string): TraeReasoningFamily | undefined {
  return TRAE_REASONING_FAMILIES.find(family => family.matches(model))
}

/**
 * The levels one route can actually act on, for the picker's menu.
 *
 * `undefined` rather than an empty list, so the caller can leave the control out
 * entirely instead of rendering a menu with nothing but `off` in it.
 * @param model - the `config_name` a request states.
 * @returns the levels, in menu order, or `undefined` when the route has no ladder.
 */
export function traeReasoningEffortsFor(model: string): readonly TraeReasoningEffort[] | undefined {
  const levels = traeReasoningFamily(model)?.levels
  if (levels === undefined) return undefined
  const offered = TRAE_REASONING_EFFORTS.filter(effort => effort === 'off' || levels[effort] !== undefined)
  // A ladder with no rung above `off` is not a control; say so instead of
  // publishing a menu whose every choice is the same request.
  return offered.length > 1 ? offered : undefined
}

/** The block one level prepends, or `undefined` when the level sends nothing. */
function traeEffortBlock(model: string, effort: string | undefined): string | undefined {
  if (effort === undefined) return undefined
  const level = effort.trim().toLowerCase()
  if (level === '' || level === 'off') return undefined
  return traeReasoningFamily(model)?.levels[level as TraeReasoningEffort]
}

/** Remove a block this module previously injected into one content value. */
function stripTraeEffort(content: unknown): unknown {
  if (typeof content === 'string') return content.replace(MARKER_PATTERN, '')
  if (!Array.isArray(content)) return content
  return content.map((part) => {
    const row = part as { readonly type?: unknown; readonly text?: unknown }
    if (row.type !== 'text' || typeof row.text !== 'string') return part
    return { ...row, text: row.text.replace(MARKER_PATTERN, '') }
  })
}

/** Prepend the block to one message's content, whichever shape it is in. */
function prependTraeEffort(content: unknown, block: string): unknown {
  const cleaned = stripTraeEffort(content)
  if (typeof cleaned === 'string') return block + cleaned
  if (Array.isArray(cleaned)) return [{ type: 'text', text: block }, ...cleaned]
  return block
}

/**
 * The message list with this turn's think-effort block in its system prompt.
 *
 * The injection lands on the *serialized* request rather than on the stored
 * conversation, so the Harness keeps replaying the user's own prompt: what the
 * session holds is never rewritten, and nothing here has to be undone later.
 * Copying the one message that changes (and the array around it) is what keeps
 * that promise while the caller's body stays untouched.
 *
 * With no system message the block becomes one, because a prompt that arrives
 * after the user's first turn is a different experiment than one that opens the
 * conversation.
 * @param messages - the OpenAI-shaped messages being sent.
 * @param model - the `config_name` this turn states.
 * @param effort - the level the caller asked for, if any.
 * @returns the messages to send; the same list when there is nothing to inject.
 */
export function withTraeThinkEffort(
  messages: readonly unknown[],
  model: string,
  effort: string | undefined,
): readonly unknown[] {
  const block = traeEffortBlock(model, effort)
  const rows = [...messages]
  const systemAt = rows.findIndex((message) => {
    const role = (message as { readonly role?: unknown } | null)?.role
    return role === 'system'
  })
  if (block === undefined) {
    // Still worth a pass: a rerun of the same turn (a retry after a failover, a
    // replayed request) must not accumulate blocks from an earlier level.
    if (systemAt < 0) return rows
    const existing = rows[systemAt] as Record<string, unknown>
    const cleaned = stripTraeEffort(existing.content)
    if (cleaned === existing.content) return rows
    rows[systemAt] = { ...existing, content: cleaned }
    return rows
  }
  const fenced = MARKER_START + block.replace(/\n+$/u, '\n') + MARKER_END
  if (systemAt < 0) return [{ role: 'system', content: fenced.trimEnd() }, ...rows]
  const system = rows[systemAt] as Record<string, unknown>
  rows[systemAt] = { ...system, content: prependTraeEffort(system.content, fenced) }
  return rows
}
