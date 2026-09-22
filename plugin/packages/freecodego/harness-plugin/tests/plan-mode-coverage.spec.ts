/**
 * Coverage: the fence answers for every tool, and the default that catches the
 * rest is still a refusal.
 *
 * Why this file exists
 * --------------------
 * Plan Mode refuses a plugin tool it has not classified, and that default is
 * deliberate: it is what stops a newly added mutating tool from becoming callable
 * while the user is only planning. But an undescribed default has a second edge —
 * a *read-only* tool that was never added to the allow list is refused too, and
 * the refusal is reported to the model as "this mode does not classify that tool
 * as safe to run while planning", which reads like a decision rather than an
 * omission.
 *
 * That is not hypothetical. `engineering_inspect` and `engineering_hunks` — the
 * two most direct ways to learn what a workspace actually contains — were both
 * unclassified, so Plan Mode refused exactly the tools its own guidance tells the
 * model to use. Nothing failed: the fence worked, the tests passed, and the
 * behaviour was wrong.
 *
 * Where the completeness is proven has since moved. The names live in
 * `src/tool-manifest.ts`, and `tests/tool-manifest.spec.ts` is what holds that table
 * against the registration literals discovered in this package — in both
 * directions, so a tool with no row and a row with no tool are both failures.
 * What is left to check *here* is the fence's own reading: that a classified name
 * produces the answer the classification states, for every row, and that a name
 * nobody classified still falls into the refusal rather than past it.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/plan-mode-coverage
 */

import { describe, expect, test } from 'vitest'

import {
  PLAN_MODE_ALLOWED_PLUGIN_TOOLS,
  PLAN_MODE_MUTATING_PLUGIN_TOOLS,
  planModeRefusal,
} from '../src/plan-mode.ts'
import { PLUGIN_TOOL_MANIFEST, pluginToolsWithPlanMode } from '../src/tool-manifest.ts'

describe('the fence answers for every classified tool', () => {
  test('an allowed name runs while planning, and a refused name does not', () => {
    // Read from the manifest rather than from the two exported lists, so this case
    // checks the fence rather than restating the table: `planModeRefusal` is the
    // one place the answer is produced, and every row has to come out of it.
    for (const row of PLUGIN_TOOL_MANIFEST) {
      const refusal = planModeRefusal({ mode: 'plan', tool: row.name })
      if (row.planMode === 'allow') {
        expect(refusal, `${row.name} is allowed by the manifest but refused by the fence`).toBeUndefined()
      } else {
        expect(refusal?.reason, `${row.name} is refused by the manifest but the fence answered ${refusal?.reason ?? 'nothing'}`).toBe('mutating-tool')
      }
      // And the mode that is not fenced answers nothing at all for the same name,
      // which is the half that keeps this from passing on a fence that refuses
      // everything.
      expect(planModeRefusal({ mode: 'execute', tool: row.name }), `${row.name} in execute mode`).toBeUndefined()
    }
    // The control: neither list is empty, so the loop above cannot pass vacuously.
    expect(PLAN_MODE_ALLOWED_PLUGIN_TOOLS.length).toBeGreaterThan(5)
    expect(PLAN_MODE_MUTATING_PLUGIN_TOOLS.length).toBeGreaterThan(5)
    expect(pluginToolsWithPlanMode('allow').length + pluginToolsWithPlanMode('refuse').length).toBe(PLUGIN_TOOL_MANIFEST.length)
  })

  test('a prefixed tool nobody classified is still refused', () => {
    // The default has to keep working: this is the property that makes the manifest
    // safe to maintain, because a tool added without a row is refused loudly rather
    // than callable silently.
    expect(planModeRefusal({ mode: 'plan', tool: 'engineering_brand_new' })?.reason).toBe('unclassified-tool')
    // The other shape is deliberately *not* refused, and the difference is worth
    // stating because it looks like a hole: a name with no declared prefix is not
    // something this fence can attribute to the plugin, so `brand_new_tool` falls
    // through the way any Harness tool does. What protects that shape is the suite
    // rather than the default — `tests/tool-manifest.spec.ts` reads the registration
    // literals and fails on a tool with no row, so a new unprefixed tool cannot ship
    // as an unclassified one, and the manifest is what makes it the plugin's own.
    // Relying on this fence for it is what left `inspect`, `spill_recall` and
    // `read_document` callable while planning for as long as nobody read the file.
    expect(planModeRefusal({ mode: 'plan', tool: 'brand_new_tool' })).toBeUndefined()
  })
})

describe('the tools the finding was about', () => {
  test('a mutating tool with no plugin prefix is still refused', () => {
    // The hole this closes: the fence found tools by prefix, so `edit_and_run` — which
    // edits a file and runs a command — was callable while planning.
    expect(planModeRefusal({ mode: 'plan', tool: 'edit_and_run' })?.reason).toBe('mutating-tool')
    expect(planModeRefusal({ mode: 'execute', tool: 'edit_and_run' })).toBeUndefined()
  })

  test('the truth-gathering tools are usable while planning', () => {
    for (const tool of ['engineering_inspect', 'engineering_hunks']) {
      expect(planModeRefusal({ mode: 'plan', tool }), `${tool} must be allowed in plan mode`).toBeUndefined()
    }
  })

  test('undoing a recorded region is refused, by name rather than by omission', () => {
    const refusal = planModeRefusal({ mode: 'plan', tool: 'engineering_hunk_revert' })
    expect(refusal?.reason).toBe('mutating-tool')
    expect(refusal?.message).toContain('Plan Mode')
  })
})
