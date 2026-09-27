/**
 * The prompt breakdown as a control signal, not only a table.
 *
 * Why
 * ---
 * `prompt-composition.ts` could say where the tokens went and nothing could act
 * on it, and `headroom` could shrink one payload against a threshold that was the
 * same whether the conversation had 5% or 95% of its window left. This file pins
 * the wire between them, and it is written around the two ways that wire can be
 * wrong:
 *
 * 1. **The quota invents the window.** It does not: the usable room is an input,
 *    the fixed categories are charged first, and the transcript gets the
 *    remainder. The cases below assert the arithmetic against figures that can be
 *    counted by hand, including the case where the fixed block alone exceeds the
 *    room — the transcript's quota there is zero, not negative, and the whole
 *    transcript is what has to be reclaimed.
 * 2. **The quota changes the compressor instead of the bar.** The compressor is
 *    untouched: the only thing a quota moves is the largest output/original ratio
 *    a candidate may ship at, and the case below proves it by holding the bytes
 *    still and moving only the quota. With no quota the payload is refused exactly
 *    as it always was; with pressure the *same* payload is delivered because the
 *    saving it can make is now enough. A quota with nothing to reclaim is the
 *    third case, and it must behave like no quota at all — otherwise every
 *    comfortable conversation would compress differently from before this
 *    existed.
 *
 * The fixture is a search result, and the shape is chosen: a reversible fold
 * applies to it *and* the search compressor applies to it, at different sizes, so
 * the bar decides **which of the two the model receives** on bytes that never
 * change. That is the sharpest form of the claim — the quota can move the delivery
 * without moving a single byte of input, which no threshold change could fake.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { buildPromptComposition, describePromptCompositionQuota, promptCompositionQuota } from '../src/prompt-composition.ts'
import { HEADROOM_SEAM_SETTINGS, headroomSeam } from './support/headroom-seam.ts'

/** A snapshot built from character counts alone, so every figure is countable. */
function snapshotWith(counts: { readonly system?: number; readonly tools?: number; readonly conversation?: number }) {
  return buildPromptComposition({
    sources: {
      ...(counts.system === undefined ? {} : { 'system-prompt': ['s'.repeat(counts.system)] }),
      ...(counts.tools === undefined ? {} : { tools: ['t'.repeat(counts.tools)] }),
      ...(counts.conversation === undefined ? {} : { conversation: ['c'.repeat(counts.conversation)] }),
    },
  })
}

/** 4000 system chars + 8000 tool chars + 40000 conversation chars, priced at 4 chars/token. */
const SNAPSHOT = snapshotWith({ system: 4_000, tools: 8_000, conversation: 40_000 })

const rowFor = (quota: ReturnType<typeof promptCompositionQuota>, id: string) => quota.categories.find(category => category.id === id)

describe('promptCompositionQuota', () => {
  it('charges the unshrinkable categories first and gives the transcript the remainder', () => {
    const quota = promptCompositionQuota(SNAPSHOT, { usableTokens: 11_000 })
    expect(quota.fixedTokens).toBe(3_000)
    expect(quota.conversationTokens).toBe(10_000)
    expect(quota.conversationQuotaTokens).toBe(8_000)
    expect(quota.reclaimTokens).toBe(2_000)
    expect(quota.pressure).toBeCloseTo(0.25, 10)
  })

  it('reports no breach for a fixed category, whose remedy is a settings change rather than a compression', () => {
    const quota = promptCompositionQuota(SNAPSHOT, { usableTokens: 11_000 })
    expect(rowFor(quota, 'tools')?.quotaTokens).toBe(2_000)
    expect(rowFor(quota, 'tools')?.overTokens).toBe(0)
    expect(rowFor(quota, 'system-prompt')?.overTokens).toBe(0)
    expect(rowFor(quota, 'conversation')?.overTokens).toBe(2_000)
  })

  it('gives the transcript a zero quota rather than a negative one when the fixed block fills the room', () => {
    const quota = promptCompositionQuota(SNAPSHOT, { usableTokens: 2_500 })
    expect(quota.conversationQuotaTokens).toBe(0)
    expect(quota.reclaimTokens).toBe(10_000)
    // No quota means no fraction to express it as — a zero denominator is stated
    // as unknown, not reported as infinite pressure.
    expect(quota.pressure).toBeUndefined()
  })

  it('renders the fixed categories as a panel that says which half of the split each row is on', () => {
    // The breakdown sorts eight rows by size and treats them alike; this panel is
    // the only place a reader learns that six of them are settings changes and
    // exactly one is the compressor's business. Both halves have to be named, or
    // the reader acts on the wrong one.
    const panel = describePromptCompositionQuota(promptCompositionQuota(SNAPSHOT, { usableTokens: 11_000 }))
    expect(panel).toContain('11,000 usable tokens')
    // Two bases, each named: the fixed block as a share of the usable room, and
    // each row as a share of the prompt the breakdown totals.
    expect(panel).toContain('3,000 (27.3% of the room) is fixed')
    expect(panel).toContain('The transcript may occupy 8,000 tokens, and it is 2,000 over that (pressure 0.25)')
    expect(panel).toContain('- Tool definitions: 2,000 tokens (15.4% of the prompt)')
    expect(panel).toContain('- System prompt: 1,000 tokens (7.7% of the prompt)')
    // The fixed rows are listed largest first, and none of them claims a breach:
    // a quota no mechanism can breach would be a pressure figure with no next step.
    expect(panel.indexOf('Tool definitions')).toBeLessThan(panel.indexOf('System prompt'))
    expect(panel).toContain('each one is a settings change')
    expect(panel).toContain('the only row compression can reclaim room from')
  })

  it('renders a fitting transcript as fitting rather than as zero pressure to fix', () => {
    const panel = describePromptCompositionQuota(promptCompositionQuota(SNAPSHOT, { usableTokens: 20_000 }))
    expect(panel).toContain('The transcript may occupy 17,000 tokens, and it is 0 over that (pressure 0.00)')
    expect(panel).toContain('against a quota of 17,000')
  })

  it('states an unmeasurable room without inventing a share of it', () => {
    // Nothing was measured, so there is no fraction to report: a `0%` here would
    // be a claim about a prompt nobody counted.
    const panel = describePromptCompositionQuota(promptCompositionQuota(SNAPSHOT, { usableTokens: 0 }))
    expect(panel).toContain('Compression budget: 0 usable tokens.')
    expect(panel).not.toContain('is fixed')
    expect(panel).not.toContain('pressure')
  })

  it('reports nothing to reclaim while the transcript fits', () => {
    const quota = promptCompositionQuota(SNAPSHOT, { usableTokens: 20_000 })
    expect(quota.conversationQuotaTokens).toBe(17_000)
    expect(quota.reclaimTokens).toBe(0)
    expect(quota.pressure).toBe(0)
    expect(rowFor(quota, 'conversation')?.overTokens).toBe(0)
  })
})

/**
 * A forty-match search result: `path:line:content` rows, which is the shape both
 * the search compressor and the search fold are written for.
 */
const SEARCH = Array.from({ length: 40 }, (_, i) => `src/compression/file-${i}.ts:${i + 10}:const value${i} = compute(${i})`).join('\n')

/**~900 characters of search rows: under the shipped 1200 threshold, over what a 32k window asks for. */
const SMALL = Array.from({ length: 18 }, (_, i) => `src/compression/small-${i}.ts:${i + 1}:const small${i} = compute(${i})`).join('\n')

/** Sixty one-hunk diffs, the shape the diff fold and the diff branch are written for. */
const DIFF = Array.from({ length: 60 }, (_, i) => `diff --git a/src/m${i}.ts b/src/m${i}.ts\n--- a/src/m${i}.ts\n+++ b/src/m${i}.ts\n@@ -1,3 +1,4 @@\n const a${i} = 1\n-const b${i} = 2\n+const b${i} = ${i + 3}\n+const c${i} = ${i}`).join('\n')

/** A nested result set, which is the shape the JSON crusher replaces cell by cell. */
const JSON_RESULT = JSON.stringify({ results: Array.from({ length: 200 }, (_, i) => ({ id: i, path: `src/f${i}.ts`, score: i / 3, tags: ['alpha', 'beta'] })), meta: { total: 200 } }, null, 2)

describe('the compression quota the runtime acts on', () => {
  /** A bar the search compressor cannot clear, so its rendering is demoted to a candidate. */
  const STRICT = { ...HEADROOM_SEAM_SETTINGS, headroomMinSavingsRatio: 0.2 }

  // Every case runs one payload through a seam of its own. A second run in the same
  // seam is a different question — the earlier result is in context, so the
  // cross-turn pointer becomes a candidate — and a fixture that can be answered by
  // a dedup pointer cannot say whether the accept bar moved.
  it('ships the weaker reversible rendering while no conversation is over its quota', async () => {
    const noQuota = headroomSeam(STRICT)
    const withoutQuota = await noQuota.run(SEARCH)
    // A quota with nothing to reclaim has to be the behaviour before quotas existed,
    // byte for byte: the same input through a second seam must come out identical.
    const reclaiming = headroomSeam(STRICT)
    reclaiming.quota({ overTokens: 0, quotaTokens: 5_000 })
    expect(await reclaiming.run(SEARCH)).toBe(withoutQuota)
    // The fallback is the fold, which is a saving but not the one written for this
    // shape — the gap is what the quota buys back below.
    expect(withoutQuota.length / SEARCH.length).toBeGreaterThan(0.6)
  })

  it('compresses a payload the configured threshold would skip once the window says it matters', async () => {
    // The threshold asks "is this payload a share of the window?". With no window the
    // shipped 1200 characters decide and this payload is skipped; on a 32k window the
    // same figure is 300, so the payload is worth the attempt.
    const withoutWindow = headroomSeam(HEADROOM_SEAM_SETTINGS)
    expect(await withoutWindow.run(SMALL)).toBe(SMALL)
    // The window is pushed on its own and with no pressure behind it, which is how
    // the caller does it: the threshold is a property of the routed model, so the bar
    // has to be the scaled one on a conversation with room to spare too. Carrying the
    // window inside the quota made this case reachable only by inventing a quota that
    // reclaims nothing — a state the real caller never sends — and left the bar at the
    // configured figure in every band below `tight`.
    const smallWindow = headroomSeam(HEADROOM_SEAM_SETTINGS)
    smallWindow.window(32_000)
    expect((await smallWindow.run(SMALL)).length).toBeLessThan(SMALL.length)
  })

  it('reports the quota and the bar it moved', async () => {
    const idle = headroomSeam(STRICT)
    expect(idle.status().quotaTokens).toBe(0)
    expect(idle.status().quotaOverTokens).toBe(0)
    // No pressure: the configured ratio is the whole answer, and a panel has to be
    // able to say so rather than show a relaxed bar nothing relaxed.
    expect(idle.status().acceptRatio).toBeCloseTo(0.2, 10)
    const pressed = headroomSeam(STRICT)
    pressed.quota({ overTokens: 100_000, quotaTokens: 5_000 })
    expect(pressed.status().quotaOverTokens).toBe(100_000)
    expect(pressed.status().quotaTokens).toBe(5_000)
    // The panel has to be able to name where the room went, not only how far over
    // the transcript is: same signal, so the same run covers both halves of the
    // subtraction, and it carries the ids a display layer localizes by.
    const named = headroomSeam(STRICT)
    named.quota({ overTokens: 1, quotaTokens: 2, fixedTokens: 3, fixedCategories: [{ id: 'tools', label: 'Tool definitions', tokens: 3 }] })
    expect(named.status()).toMatchObject({ quotaFixedTokens: 3, quotaFixedCategories: [{ id: 'tools', tokens: 3 }] })
    // Nothing measured: an empty list, not an undefined one, because the panel
    // renders it directly and `undefined.map` is a crash rather than a blank row.
    expect(idle.status().quotaFixedTokens).toBe(0)
    expect(idle.status().quotaFixedCategories).toEqual([])
    // pressure 20 → saving 0.8/21 ≈ 0.038 → bar ≈ 0.962
    expect(pressed.status().acceptRatio).toBeGreaterThan(0.9)
    expect(pressed.status().acceptRatio).toBeLessThan(0.98)
  })

  it('does not move a rendering that is far under the configured bar at the shipped setting', async () => {
    // Where the relaxation can act is a *band*, not a shape: only a candidate whose
    // ratio lands between the configured bar and the relaxed one can flip, and with the
    // shipped 0.85 that band is 0.85–0.98 of the input's bytes. The typed branches
    // deliver well under it — measured through this seam: search 0.43, diff 0.34, JSON
    // 0.36, log 0.015, code skeleton 0.13 — so on all of them pressure changes nothing
    // in a default deployment. That is why the observable cases above have to configure
    // a stricter bar, and a quota assumed to be doing work everywhere is a claim nobody
    // measured.
    for (const payload of [SEARCH, DIFF, JSON_RESULT]) {
      const idle = await headroomSeam(HEADROOM_SEAM_SETTINGS).run(payload)
      // The fixture has to compress on its own, or the equality below would hold for
      // two refusals and prove nothing about the bar.
      expect(idle.length).toBeLessThan(payload.length)
      const pressed = headroomSeam(HEADROOM_SEAM_SETTINGS)
      pressed.quota({ overTokens: 100_000, quotaTokens: 5_000 })
      expect(await pressed.run(payload)).toBe(idle)
    }
  })

  it('delivers the shape-specific rendering once the transcript is over its quota', async () => {
    const cold = headroomSeam(STRICT)
    const before = await cold.run(SEARCH)
    const warm = headroomSeam(STRICT)
    warm.quota({ overTokens: 100_000, quotaTokens: 5_000 })
    const after = await warm.run(SEARCH)
    expect(after.length).toBeLessThan(before.length)
    expect(after.length / SEARCH.length).toBeLessThan(0.5)
    expect(warm.status().compressions).toBe(1)
  })
})
