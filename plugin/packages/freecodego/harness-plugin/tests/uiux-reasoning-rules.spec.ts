/**
 * Regression coverage for the vendored catalog's decision-rule grammar.
 *
 * Why the refusals are the cases that matter
 * -----------------------------------------
 * A rule set that parses is the normal state; a rule set that should *not* have
 * parsed is where the cost is. Upstream's own comment on this file calls the grammar
 * "closed and non-executable", and the property that makes that true is that every
 * way of leaving the grammar is refused at parse time. A validation that degrades to
 * a warning leaves a rule in the table that fires nothing, and a rule that fires
 * nothing is indistinguishable from a rule whose condition never matched a query —
 * so nobody finds it, and the recommendation silently loses half its actions.
 *
 * The case a JSON parse cannot make
 * ---------------------------------
 * `JSON.parse` keeps the last of two identical keys. Measured here rather than
 * asserted in prose: the duplicate case below first shows what a parse yields (one
 * key, the second value, the first value gone with no trace) and only then shows that
 * the parser refuses it. A test that skipped the first half would pass against a
 * parser that read the parsed object instead of the text.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/uiux-reasoning-rules
 */

import { describe, expect, it } from 'vitest'

import {
  applyDecisionRules,
  CONDITION_SIGNALS,
  MUST_HAVE_CONDITION,
  parseDecisionRules,
  topLevelKeys,
} from '../src/uiux/reasoning-rules.ts'

/** A rule cell that uses every action prefix once. */
const FULL_CELL = JSON.stringify({
  [MUST_HAVE_CONDITION]: ['constraint:state-every-default', 'constraint:render-at-two-widths'],
  if_mobile: ['style:mobile-first-bottom-nav', 'mode:dark'],
  if_dashboard: ['pattern:Dashboard Shell', 'style:dense-data-grid'],
})

describe('the condition vocabulary', () => {
  it('is the ported set, with no condition silently dropped', () => {
    // A shortened vocabulary is invisible at runtime: the rules that key off a missing
    // condition simply never fire, and their actions are simply absent from every
    // recommendation. The count is exact rather than a floor because the port was
    // checked against the source once, mechanically, for every key and every signal;
    // an added condition fails here and gets that same check rather than a bumped
    // number.
    expect(Object.keys(CONDITION_SIGNALS).length).toBe(35)
    expect(CONDITION_SIGNALS.if_mobile).toContain('ios')
    expect(CONDITION_SIGNALS.if_trust_needed).toContain('verified')
    expect(MUST_HAVE_CONDITION).toBe('must_have')
  })
})

describe('parsing', () => {
  it('refuses a duplicated condition, which a JSON parse would have merged', () => {
    // The two spellings differ by an escape, so a scan that compared raw key text
    // would see two distinct keys and let this through.
    const duplicated = '{"if_mobile":["style:a"],"\\u0069f_mobile":["style:b"]}'
    const asParsed = JSON.parse(duplicated) as Record<string, unknown>
    // What the parse alone yields: one key, the second value, the first gone. This is
    // the loss the scan exists to catch, and it is unobservable in the merged object.
    expect(Object.keys(asParsed)).toStrictEqual(['if_mobile'])
    expect(asParsed.if_mobile).toStrictEqual(['style:b'])
    expect(() => parseDecisionRules(duplicated)).toThrow(/duplicate decision-rule key: if_mobile/u)
  })

  it('reads a key at depth one and ignores a key inside a value', () => {
    // The scan is a text walk, so its denominator is the thing that can be wrong: a
    // key inside an action's value is not a rule, and a scan that collected it would
    // report a duplicate for a cell that has none.
    expect(topLevelKeys('{"if_mobile":["style:a"],"if_hero_needed":["constraint:b"]}'))
      .toStrictEqual(['if_mobile', 'if_hero_needed'])
    expect(topLevelKeys('{"if_mobile":["constraint:{\\"nested\\":1}"]}')).toStrictEqual(['if_mobile'])
  })

  it('refuses an unknown condition, a malformed action, and an empty action list', () => {
    // Every refusal names the offending text: a validator that says only "invalid
    // rules" makes the table's author re-read the whole cell to find one token.
    expect(() => parseDecisionRules('{"if_something_else":["style:a"]}')).toThrow(/unknown decision-rule condition: if_something_else/u)
    expect(() => parseDecisionRules('{"if_mobile":["style:Mobile First"]}')).toThrow(/invalid style action value/u)
    expect(() => parseDecisionRules('{"if_mobile":["constraint:two words"]}')).toThrow(/invalid constraint action value/u)
    expect(() => parseDecisionRules('{"if_mobile":["colour:blue"]}')).toThrow(/unknown decision-rule action/u)
    expect(() => parseDecisionRules('{"if_mobile":["style:a","style:a"]}')).toThrow(/duplicate actions/u)
    expect(() => parseDecisionRules('{"if_mobile":[]}')).toThrow(/non-empty action array/u)
    expect(() => parseDecisionRules('{"if_mobile":"style:a"}')).toThrow(/non-empty action array/u)
  })

  it('bounds a pattern and a mode to the values the rest of the catalog can use', () => {
    // `pattern:` has to name something, because the aggregator looks the name up in
    // the landing table and a blank lookup reads as an absent one. `mode:` has two
    // legal values because the colour resolver compares against exactly those.
    expect(() => parseDecisionRules('{"if_mobile":["pattern:  "]}')).toThrow(/pattern action must name a pattern/u)
    expect(() => parseDecisionRules('{"if_mobile":["mode:auto"]}')).toThrow(/mode action must be dark or light/u)
    expect(parseDecisionRules('{"if_mobile":["mode:dark"]}').get('if_mobile')).toStrictEqual(['mode:dark'])
  })

  it('treats an absent or empty cell as an empty rule set', () => {
    // A row whose cell is blank states no rules. That is a parse, not an error — and
    // it must not be read as "the rules are unreadable", which would be a finding.
    expect([...parseDecisionRules(undefined)]).toStrictEqual([])
    expect([...parseDecisionRules('')]).toStrictEqual([])
  })

  it('refuses text that is not a JSON object', () => {
    expect(() => parseDecisionRules('not json')).toThrow(/invalid decision-rule JSON/u)
    expect(() => parseDecisionRules('["if_mobile"]')).toThrow(/must be a JSON object/u)
  })
})

describe('applying', () => {
  const rules = parseDecisionRules(FULL_CELL)

  it('activates the unconditional block on every query', () => {
    // `must_have` is what makes a rule row carry always-true guidance; without it a
    // row whose conditions are all narrow would contribute nothing on a query that
    // matches none of them, which is the common case.
    const applied = applyDecisionRules(rules, 'a quiet page about nothing in particular')
    expect(applied.activated.map(entry => entry.condition)).toStrictEqual([MUST_HAVE_CONDITION])
    expect(applied.constraints).toStrictEqual(['state-every-default', 'render-at-two-widths'])
    expect(applied.pattern).toBeUndefined()
  })

  it('reports activations in table order, with the actions each condition contributed', () => {
    // The trail is what a reader uses to explain a recommendation. An order that
    // followed iteration over a hash would look the same in one run and differ in the
    // next, which is how an audit trail stops being evidence.
    const applied = applyDecisionRules(rules, 'a mobile dashboard for on-call engineers')
    expect(applied.activated.map(entry => entry.condition)).toStrictEqual([
      MUST_HAVE_CONDITION, 'if_mobile', 'if_dashboard',
    ])
    expect(applied.activated[1]?.actions).toStrictEqual(['style:mobile-first-bottom-nav', 'mode:dark'])
    expect(applied.styleIds).toStrictEqual(['mobile-first-bottom-nav', 'dense-data-grid'])
    expect(applied.pattern).toBe('Dashboard Shell')
    expect(applied.mode).toBe('dark')
  })

  it('matches a signal on its word boundaries only', () => {
    // `ios` is a signal, and `kiosk` contains it. A substring match would route a
    // kiosk request to the mobile rules — the kind of false activation that is
    // indistinguishable from a correctly matched one in the output.
    expect(applyDecisionRules(rules, 'a kiosk display in a lobby').activated).toHaveLength(1)
    expect(applyDecisionRules(rules, 'an app for ios').activated).toHaveLength(2)
  })

  it('requires a multi-word signal to appear as those words in that order', () => {
    // `data heavy` is one signal; `heavy data` is not a phrase anyone agreed on, and
    // accepting it would mean the signal's text no longer says which inputs fire it.
    const heavy = parseDecisionRules('{"if_data_heavy":["style:dense-tables"]}')
    expect(applyDecisionRules(heavy, 'a data heavy report').styleIds).toStrictEqual(['dense-tables'])
    expect(applyDecisionRules(heavy, 'a heavy data report').styleIds).toStrictEqual([])
  })

  it('deduplicates a style two conditions both name, keeping the earlier position', () => {
    // Two conditions naming the same style is a table stating one preference twice.
    // Listing it twice would make the aggregator weigh it twice, so a style named by
    // two fired conditions would outrank one named once for no stated reason.
    const repeated = parseDecisionRules(JSON.stringify({
      [MUST_HAVE_CONDITION]: ['style:minimalism'],
      if_mobile: ['style:minimalism', 'style:dense-data-grid'],
    }))
    const applied = applyDecisionRules(repeated, 'a mobile dashboard')
    expect(applied.activated).toHaveLength(2)
    expect(applied.styleIds).toStrictEqual(['minimalism', 'dense-data-grid'])
  })
})
