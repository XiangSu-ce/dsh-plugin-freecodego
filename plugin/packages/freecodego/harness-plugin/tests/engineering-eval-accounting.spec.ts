/**
 * An evaluation case is only worth its point if its score moves when the
 * behaviour it claims breaks. The media case states two things — vendors'
 * generation families are recognised, AND a vision *input* is not a generator —
 * and it even prints the false-positive count in its detail line, so a score
 * that only counts the generator rows reports a green for a claim half of which
 * was never checked.
 *
 * The mutation below is exactly that broken world: an id that merely reads
 * images starts being reported as a generator. The sibling media-chain case
 * (`media.category-inference-covers-vendors`) scores its vision row in the
 * expectation table, so it is the control — it must flip to failing under the
 * same mutation, proving the mutation is what fails the other case.
 */

import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ brokenVision: false }))

vi.mock('../src/media-utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/media-utils.ts')>()
  return {
    ...actual,
    inferMediaCategory: (value: string) =>
      actual.inferMediaCategory(value) ?? (state.brokenVision && value.includes('-vision') ? 'image' as const : undefined),
  }
})

describe('evaluation case accounting', { timeout: 120_000 }, () => {
  it('scores the vision half of the media claim, not only the generator half', async () => {
    const { runEngineeringEval } = await import('../src/engineering-eval.ts')
    const verdicts = async (): Promise<ReadonlyMap<string, boolean>> =>
      new Map((await runEngineeringEval()).cases.map(entry => [entry.id, entry.passed]))

    state.brokenVision = false
    const healthy = await verdicts()
    expect(healthy.get('media.route-classification'), 'healthy classifier').toBe(true)
    expect(healthy.get('media.category-inference-covers-vendors'), 'healthy classifier').toBe(true)

    state.brokenVision = true
    const mutated = await verdicts()
    // The control: this case has always scored its vision row, so the mutation
    // is demonstrably the reason the next assertion can fail.
    expect(mutated.get('media.category-inference-covers-vendors'), 'mutated classifier').toBe(false)
    expect(mutated.get('media.route-classification'), 'mutated classifier').toBe(false)
  })
})
