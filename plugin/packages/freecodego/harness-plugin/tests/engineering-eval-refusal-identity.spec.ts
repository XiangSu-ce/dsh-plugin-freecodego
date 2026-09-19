/**
 * A negative case that only asks "did it throw" scores 1 for *any* refusal, so
 * the wording can move underneath it — a guard refactored to a different
 * message, or its rule replaced by a sibling's — while the case keeps its point
 * and the scorecard keeps advertising a check that no longer exists.
 *
 * The cases now name the reason they expect. This mutation holds the behaviour
 * fixed and moves only the wording: the same range and filter refusals, told in
 * different words. The identity-checked cases must flip to failing, while cases
 * that read the same function without refusing stay green — the control that the
 * run is healthy and the flip is attributable to the wording rather than to the
 * mock's presence.
 *
 * The third state is the other drift a fixture can suffer: a call that refuses
 * because it can no longer read what it was handed at all (a `TypeError`) is a
 * broken case, not a measured refusal, so it must be reported as unrunnable
 * instead of scored.
 */

import { describe, expect, it, vi } from 'vitest'

/** `honest` ships the guard's own wording; the other two are drifts. */
type Mode = 'honest' | 'renamed' | 'unreadable-fixture'

const state = vi.hoisted(() => ({ mode: 'honest' as 'honest' | 'renamed' | 'unreadable-fixture' }))

vi.mock('../src/token-usage.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/token-usage.ts')>()
  return {
    ...actual,
    buildLocalTokenUsageSnapshot: async (...args: Parameters<typeof actual.buildLocalTokenUsageSnapshot>) => {
      try {
        return await actual.buildLocalTokenUsageSnapshot(...args)
      } catch (error: unknown) {
        if (state.mode === 'honest') throw error
        // Same rule, same verdict, different words: the behaviour the cases claim
        // to check is untouched, so only identity can tell the difference.
        if (state.mode === 'renamed') throw new Error('invalid token usage query: the range or filter was rejected')
        throw new TypeError("Cannot read properties of undefined (reading 'list')")
      }
    },
  }
})

describe('evaluation refusal identity', { timeout: 120_000 }, () => {
  it('flips the negative cases when only the refusal wording drifts', async () => {
    const { runEngineeringEval } = await import('../src/engineering-eval.ts')
    const verdicts = async (): Promise<ReadonlyMap<string, { readonly passed: boolean; readonly id: string; readonly failure?: string }>> =>
      new Map((await runEngineeringEval()).cases.map(entry => [entry.id, entry]))

    state.mode = 'honest'
    const honest = await verdicts()
    expect(honest.get('usage.range-validation')?.passed, 'honest wording').toBe(true)
    expect(honest.get('usage.overlong-filter-is-refused')?.passed, 'honest wording').toBe(true)

    state.mode = 'renamed'
    const renamed = await verdicts()
    expect(renamed.get('usage.range-validation')?.passed, 'renamed refusal').toBe(false)
    expect(renamed.get('usage.overlong-filter-is-refused')?.passed, 'renamed refusal').toBe(false)
    // Controls: both read the same mocked module, and neither refuses, so the
    // mutation is demonstrably what failed the two assertions above.
    expect(renamed.get('usage.day-granularity-is-the-default')?.passed, 'unaffected usage case').toBe(true)
    expect(renamed.get('account.identity-requires-email-and-balance')?.passed, 'untouched module').toBe(true)

    state.mode = 'unreadable-fixture'
    const unreadable = await verdicts()
    const entry = unreadable.get('usage.range-validation')
    expect(entry?.passed, 'a broken case is not a measured refusal').toBe(false)
    // The reason must survive into the report: a case that silently scored here
    // would be the same defect one level up.
    expect(entry?.failure ?? '', entry?.id).toContain('the case could not run')
  })
})
