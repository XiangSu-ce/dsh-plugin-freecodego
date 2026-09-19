/**
 * The delegation progress bar must never exceed 100%.
 *
 * `cancelled` is a terminal state and is already counted by `failed`; the old
 * code added it a second time, so any cancelled child pushed the bar past 100%
 * (and the aria-valuenow with it).
 */

import { describe, expect, it } from 'vitest'
import { summarizeAgentProgress } from '../src/client/agent-progress.tsx'
import type { FreeCodeGoAgentProgressEntry, FreeCodeGoAgentProgressState } from '@deepseek-ai/dsh-freecodego-harness-plugin'

const agent = (state: FreeCodeGoAgentProgressState): FreeCodeGoAgentProgressEntry => ({
  id: `agent-${state}-${Math.random().toString(36).slice(2, 8)}`,
  label: state,
  state,
  toolUses: 0,
  startedAt: 0,
  updatedAt: 0,
})

describe('agent progress summary', () => {
  it('counts a cancelled child once and caps progress at 100%', () => {
    const summary = summarizeAgentProgress([agent('cancelled'), agent('completed')])
    expect(summary.failed).toBe(1)
    expect(summary.completed).toBe(1)
    expect(summary.progressPercent).toBe(100)
  })

  it('treats mixed terminal states as fully settled', () => {
    const summary = summarizeAgentProgress([agent('completed'), agent('failed'), agent('cancelled'), agent('running')])
    expect(summary.completed).toBe(1)
    expect(summary.failed).toBe(2)
    expect(summary.running).toBe(1)
    expect(summary.progressPercent).toBe(75)
  })

  it('reports zero for an empty delegation', () => {
    expect(summarizeAgentProgress([]).progressPercent).toBe(0)
  })
})
