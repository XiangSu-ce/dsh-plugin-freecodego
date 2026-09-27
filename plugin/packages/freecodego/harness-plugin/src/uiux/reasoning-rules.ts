/**
 * The decision rules of the vendored UI/UX catalog: a closed, non-executable grammar.
 *
 * Why the grammar is closed
 * -------------------------
 * A rule file is data that arrives from a vendored table, and it is read on the way
 * to a recommendation the model acts on. The cheapest way to make such a file
 * expressive is to let it carry expressions; that is also the way to make it a
 * remote-code surface whose behaviour nobody can enumerate. So an action has one of
 * four prefixes, a style or constraint value has to match a token pattern, a `mode`
 * action has two legal values, and a condition has to be one of the signals below.
 * Anything else is refused *at parse time*, with the offending text named, rather
 * than carried forward to be ignored later.
 *
 * Why the refusal is here and not at the call site
 * ------------------------------------------------
 * `_object_without_duplicates`, the allowed-condition check, the non-empty action
 * array, the duplicate-action check and the token validation all belong to the same
 * decision, and that decision is "is this file a rule set at all". Splitting them
 * across call sites is how one of them stops running: the shape that breaks is a
 * table nobody re-read, and the failure mode is a rule that quietly does nothing.
 *
 * The one thing a JSON parse cannot see
 * ------------------------------------
 * `JSON.parse` silently keeps the last of two identical keys, which turns a
 * duplicated condition into a rule that lost half its actions with no trace. The
 * duplicate scan below therefore reads the *text* before the parse is trusted, and
 * it is the reason this module takes the raw string rather than a parsed value.
 *
 * @module uiux/reasoning-rules
 */

import { redactCredentialShapes } from '../secret-scan.ts'

/** The one condition that is always active; it carries a rule row's unconditional actions. */
export const MUST_HAVE_CONDITION = 'must_have'

/**
 * Condition name to the phrases that activate it.
 *
 * Phrases are matched at token boundaries against the casefolded query, so `spa`
 * does not fire inside `spatial` and `data heavy` matches only as those two words in
 * that order. The list is upstream's, ported whole: each entry is a judgement about
 * which phrasings mean the same requirement, and a partial list would silently stop
 * electing the rules that depend on the missing ones.
 */
export const CONDITION_SIGNALS: Readonly<Record<string, readonly string[]>> = {
  if_booking: ['booking', 'appointment', 'calendar'],
  if_boutique: ['boutique'],
  if_casual: ['casual', 'playful'],
  if_checkout: ['checkout', 'payment', 'purchase'],
  if_children: ['child', 'children', 'kids'],
  if_collaboration: ['collaboration', 'multiplayer', 'co-edit'],
  if_competitive: ['competitive', 'leaderboard'],
  if_content_focused: ['content', 'article', 'reading', 'documentation'],
  if_conversion_focused: ['conversion', 'sales', 'signup', 'purchase'],
  if_creative_field: ['creative', 'artist', 'portfolio'],
  if_crop_focused: ['crop', 'farm', 'agriculture'],
  if_dashboard: ['dashboard', 'operations', 'monitoring'],
  if_data_heavy: ['data heavy', 'data-heavy', 'analytics', 'large dataset'],
  if_delivery: ['delivery', 'courier', 'shipping'],
  if_discovery_focused: ['discover', 'discovery', 'browse', 'directory'],
  if_engagement_metric: ['engagement', 'retention', 'contribution'],
  if_experience_focused: ['experience', 'immersive', 'journey'],
  if_gamification: ['gamification', 'badges', 'streak'],
  if_health: ['health', 'medical', 'patient'],
  if_hero_needed: ['hero', 'showcase', 'launch'],
  if_large_dataset: ['large dataset', 'thousands', 'millions'],
  if_light_mode_needed: ['light mode', 'light theme'],
  if_low_performance: ['low performance', 'low-end', 'slow device'],
  if_luxury: ['luxury', 'premium', 'high-end'],
  if_medication: ['medication', 'medicine', 'prescription'],
  if_meditation: ['meditation', 'breathing', 'mindfulness'],
  if_minimal_portfolio: ['minimal portfolio', 'simple portfolio'],
  if_mobile: ['mobile', 'phone', 'tablet', 'ios', 'android'],
  if_personalized: ['personalized', 'personalised', 'recommendation'],
  if_pre_launch: ['pre-launch', 'prelaunch', 'coming soon', 'waitlist'],
  if_salary_focused: ['salary', 'compensation', 'pay range'],
  if_team_collaboration: ['team collaboration', 'team workspace'],
  if_trust_needed: ['trust', 'secure', 'verified', 'authority'],
  if_ux_focused: ['ux', 'usability', 'accessibility', 'accessible'],
  if_video_ready: ['video ready', 'product video', 'demo video'],
}

/** The action prefixes a rule may use. */
const ACTION_PREFIXES: ReadonlySet<string> = new Set(['constraint', 'style', 'pattern', 'mode'])

/** The prefixes whose value has to be a single well-formed token. */
const TOKEN_ACTION_PREFIXES: ReadonlySet<string> = new Set(['constraint', 'style'])

/** The shape of a style or constraint value: lowercase words joined by hyphens. */
const TOKEN_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** The legal values of a `mode` action. */
const MODES: ReadonlySet<string> = new Set(['dark', 'light'])

/** The condition patterns, compiled once, longest phrase first inside each condition. */
const CONDITION_PATTERNS: ReadonlyMap<string, readonly RegExp[]> = new Map(
  Object.entries(CONDITION_SIGNALS).map(([condition, signals]) => [
    condition,
    signals.map(signal => new RegExp(`(?<!\\w)${signal.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?!\\w)`, 'u')),
  ]),
)

/** One activated condition with the actions it contributed. */
export interface ActivatedCondition {
  /** The condition's name, as written in the table. */
  readonly condition: string
  /** The actions it contributed, in table order. */
  readonly actions: readonly string[]
}

/** What a rule row decides, once its conditions have been evaluated against a query. */
export interface AppliedDecisionRules {
  /** Every condition that fired, in table order — the audit trail of the decision. */
  readonly activated: readonly ActivatedCondition[]
  /** Styles named by `style:` actions, in the order they were named, deduplicated. */
  readonly styleIds: readonly string[]
  /** Constraints named by `constraint:` actions, in the order they were named, deduplicated. */
  readonly constraints: readonly string[]
  /** The `pattern:` action's value, last one wins, as upstream decides. */
  readonly pattern: string | undefined
  /** The `mode:` action's value, last one wins, as upstream decides. */
  readonly mode: 'dark' | 'light' | undefined
}

/**
 * Read a full JSON string starting at a quote, escapes preserved.
 *
 * The escapes are kept verbatim rather than decoded because the caller compares
 * these strings to each other; decoding is only needed for the key's identity, and
 * that is done once, by the parser, for the case where two spellings differ only by
 * an escape.
 *
 * @param raw - the JSON text.
 * @param start - the index of the opening quote.
 * @returns the string's contents and the index just past its closing quote.
 */
function readJsonString(raw: string, start: number): { readonly text: string; readonly end: number } {
  let text = ''
  let index = start + 1
  while (index < raw.length) {
    // `charAt` rather than an indexed read: the loop condition already proves the
    // index is in range, and a non-null assertion here would be a claim the compiler
    // cannot check but the linter has to trust.
    const character = raw.charAt(index)
    if (character === '\\') {
      text += raw.slice(index, index + 2)
      index += 2
      continue
    }
    if (character === '"') return { text, end: index + 1 }
    text += character
    index += 1
  }
  return { text, end: raw.length }
}

/**
 * The object's own keys, in document order, with their escaping decoded.
 *
 * Only keys at depth one are collected, because those are the conditions; a key
 * inside an action's value is not a rule. A key's identity is its decoded text, so
 * `"if_mobile"` and `"\u0069f_mobile"` are the same key and the duplicate scan can
 * see that where a comparison of raw text could not.
 *
 * @param raw - the JSON text.
 * @returns every top-level key, in the order it appears.
 */
export function topLevelKeys(raw: string): readonly string[] {
  const keys: string[] = []
  let depth = 0
  let index = 0
  while (index < raw.length) {
    const character = raw.charAt(index)
    if (character === '"') {
      const { text, end } = readJsonString(raw, index)
      let afterString = end
      while (afterString < raw.length && /\s/u.test(raw.charAt(afterString))) afterString += 1
      if (depth === 1 && raw[afterString] === ':') {
        try {
          keys.push(JSON.parse(`"${text}"`) as string)
        } catch {
          keys.push(text)
        }
      }
      index = end
      continue
    }
    if (character === '{' || character === '[') depth += 1
    else if (character === '}' || character === ']') depth -= 1
    index += 1
  }
  return keys
}

/**
 * Validate one action against the closed grammar.
 *
 * @param action - the action text, as written in the table.
 * @throws Error when the action uses an unknown prefix, a malformed token, an empty pattern, or an illegal mode.
 */
function validateAction(action: unknown): asserts action is string {
  if (typeof action !== 'string' || !action.includes(':')) {
    throw new Error(`action must use a known prefix: ${String(action)}`)
  }
  const separator = action.indexOf(':')
  const prefix = action.slice(0, separator)
  const value = action.slice(separator + 1)
  if (!ACTION_PREFIXES.has(prefix)) throw new Error(`unknown decision-rule action: ${action}`)
  if (TOKEN_ACTION_PREFIXES.has(prefix) && !TOKEN_PATTERN.test(value)) {
    throw new Error(`invalid ${prefix} action value: ${action}`)
  }
  if (prefix === 'pattern' && value.trim() === '') throw new Error('pattern action must name a pattern')
  if (prefix === 'mode' && !MODES.has(value)) throw new Error('mode action must be dark or light')
}

/**
 * Parse a table's decision-rule cell into the conditions it declares.
 *
 * The returned map keeps insertion order, and that order is the order `activated`
 * reports — which is the order upstream's dict produced. It is also why the parse
 * returns a map rather than a plain object: an object would reorder integer-like
 * keys ascending, so a future condition named `"2"` would silently report its
 * activation in a different position than the table wrote it, and nothing else in
 * this module would notice.
 *
 * @param raw - the cell's text: a JSON object of condition to non-empty action array.
 * @throws Error when the text is not a JSON object, repeats a key, names an unknown condition, or carries an invalid action.
 * @returns the conditions, in table order.
 */
export function parseDecisionRules(raw: string | undefined): ReadonlyMap<string, readonly string[]> {
  const text = raw ?? '{}'
  const keys = topLevelKeys(text)
  const seen = new Set<string>()
  for (const key of keys) {
    if (seen.has(key)) throw new Error(`duplicate decision-rule key: ${key}`)
    seen.add(key)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text === '' ? '{}' : text)
  } catch (error) {
    // Masked rather than quoted: Node's parse error echoes the first characters of
    // the text it rejected, and a rule file is read from disk rather than authored
    // here. Same shape, and same reason, as the project-config note.
    throw new Error(`invalid decision-rule JSON: ${redactCredentialShapes(error instanceof Error ? error.message : String(error))}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('decision rules must be a JSON object')
  }
  const rules = new Map<string, readonly string[]>()
  for (const [condition, actions] of Object.entries(parsed as Record<string, unknown>)) {
    if (condition !== MUST_HAVE_CONDITION && !(condition in CONDITION_SIGNALS)) {
      throw new Error(`unknown decision-rule condition: ${condition}`)
    }
    if (!Array.isArray(actions) || actions.length === 0) {
      throw new Error(`${condition} must map to a non-empty action array`)
    }
    for (const action of actions) validateAction(action)
    if (new Set(actions).size !== actions.length) throw new Error(`${condition} contains duplicate actions`)
    rules.set(condition, actions as readonly string[])
  }
  return rules
}

/**
 * Evaluate the rules against a query.
 *
 * Nothing here executes anything: a condition fires on phrase matches and an action
 * is a value that is collected. That is the property that lets a vendored table be
 * read on the path to a recommendation at all.
 *
 * @param rules - a parsed rule set.
 * @param query - the user's request, matched casefolded at token boundaries.
 * @returns the activated conditions and what they decided.
 */
export function applyDecisionRules(
  rules: ReadonlyMap<string, readonly string[]>,
  query: string,
): AppliedDecisionRules {
  const normalized = query.toLowerCase()
  const styleIds: string[] = []
  const constraints: string[] = []
  const activated: ActivatedCondition[] = []
  let pattern: string | undefined
  let mode: 'dark' | 'light' | undefined
  for (const [condition, actions] of rules) {
    const active = condition === MUST_HAVE_CONDITION
      || (CONDITION_PATTERNS.get(condition) ?? []).some(pattern_ => pattern_.test(normalized))
    if (!active) continue
    activated.push({ condition, actions: [...actions] })
    for (const action of actions) {
      const separator = action.indexOf(':')
      const prefix = action.slice(0, separator)
      const value = action.slice(separator + 1)
      if (prefix === 'style') {
        if (!styleIds.includes(value)) styleIds.push(value)
      } else if (prefix === 'constraint') {
        if (!constraints.includes(value)) constraints.push(value)
      } else if (prefix === 'pattern') {
        pattern = value
      } else if (prefix === 'mode') {
        mode = value as 'dark' | 'light'
      }
    }
  }
  return { activated, styleIds, constraints, pattern, mode }
}
