/**
 * The gateway usage snapshot the Host hands to the Token usage page.
 *
 * `/agent/usage` answers with more than the per-request sample: it also returns
 * the window's own rollups (`daily_trend`, `windows`, `threads`) plus the
 * `summary` and `aggregation_source` that say which store answered. The Host
 * used to keep `turns` alone, and `turns` is a bounded sample of the newest
 * requests — so the page reported a fraction of the gateway's real usage and
 * every model it could not name was shown as unknown. These tests pin the
 * whole payload, not just the part the page happens to read today.
 *
 * @module tests/gateway-usage
 */

import { describe, expect, it } from 'vitest'
import { tokenUsageGateway } from '../src/payment-remotes.ts'
import type { JsonValue } from '../src/types.ts'

/** Sum one rollup row's token split, which is how the page reads it too. */
const rowTokens = (value: JsonValue): number => {
  const row = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as { readonly [key: string]: JsonValue } : {}
  const field = (key: string): number => typeof row[key] === 'number' ? row[key] : 0
  return field('total_input_tokens') + field('total_output_tokens')
}

const trendPoints = (count: number, tokensEach: number): readonly Record<string, unknown>[] =>
  Array.from({ length: count }, (_, index) => ({
    date: `2026-09-${String(index + 1).padStart(2, '0')}`,
    total_requests: 100,
    total_input_tokens: tokensEach / 2,
    total_output_tokens: tokensEach / 2,
    total_actual_cost: 0.1,
  }))

/** The narrow host view the remote reads: five endpoint calls and one token. */
const host = (endpoints: Record<string, unknown>): never => ({
  api: endpoints,
  account: {
    snapshot: () => ({ status: 'authenticated' }),
    withAccessToken: async (fn: (token: string) => Promise<unknown>) => fn('token'),
  },
  restoreAccount: async () => {},
}) as never

describe('gateway usage snapshot', () => {
  it('carries the window rollups beside the bounded turn sample', async () => {
    // The shape that produced the bug: 100 sampled turns against a window whose
    // rollup holds thousands of requests. Dropping `daily_trend` here is what
    // made the page show 0 tokens under a 4.7M-token day.
    const turns = Array.from({ length: 100 }, (_, index) => ({ id: `usage-${index}`, model: '', total_tokens: 10, actual_cost: 0.001 }))
    const snapshot = await tokenUsageGateway(host({
      getUsageDashboardStats: async () => ({ total_cost: 0.353 }),
      getUsageDashboardModels: async () => ({ models: [] }),
      getUsageDashboardTrend: async () => ({ trend: [] }),
      getUsageDashboardInsights: async () => ({}),
      getUsage: async () => ({
        turns,
        daily_trend: trendPoints(30, 100_000),
        windows: [{ id: 'window-1', total_tokens: 1_000 }],
        threads: [{ id: 'thread-1', total_tokens: 2_000 }],
        aggregation_source: 'usage_daily_summaries',
      }),
    }), 30)

    expect(snapshot.status).toBe('available')
    expect(snapshot.turns).toHaveLength(100)
    expect(snapshot.dailyTrend).toHaveLength(30)
    // 30 days x 100k tokens: the total the turn sample can never reconstruct.
    const rolled = (snapshot.dailyTrend ?? []).reduce<number>((sum, row) => sum + rowTokens(row), 0)
    expect(rolled).toBe(3_000_000)
    expect(snapshot.windows).toEqual([{ id: 'window-1', total_tokens: 1_000 }])
    expect(snapshot.threads).toEqual([{ id: 'thread-1', total_tokens: 2_000 }])
    expect(snapshot.aggregationSource).toBe('usage_daily_summaries')
    expect(snapshot.summary).toEqual({ total_cost: 0.353 })
  })

  it('falls back to the insights payload on a short window', async () => {
    // A <=7-day window is served by the insights endpoint, which reports both
    // the summary and the per-model table; the long window has no such fallback
    // and has to make do with the stats endpoint.
    const snapshot = await tokenUsageGateway(host({
      getUsageDashboardStats: async () => ({ total_cost: 9.99 }),
      getUsageDashboardModels: async () => ({ models: [] }),
      getUsageDashboardTrend: async () => ({ trend: [] }),
      getUsageDashboardInsights: async () => ({
        summary: { total_cost: 0.42 },
        models: [{ model: 'glm-5.3', total_tokens: 7_000 }],
        daily_trend: trendPoints(7, 1_000),
      }),
      getUsage: async () => ({ turns: [] }),
    }), 7)

    expect(snapshot.models).toEqual([{ model: 'glm-5.3', total_tokens: 7_000 }])
    expect(snapshot.timeline).toHaveLength(7)
  })

  it('reduces the model table into the summary when the endpoint sends no summary', async () => {
    // The Host-side fallback the page leans on when a Host sends turns with no
    // rollup at all: the model rows are the only total available.
    const snapshot = await tokenUsageGateway(host({
      getUsageDashboardStats: async () => ({ total_cost: 9.99 }),
      getUsageDashboardModels: async () => ({ models: [] }),
      getUsageDashboardTrend: async () => ({ trend: [] }),
      getUsageDashboardInsights: async () => ({
        models: [
          { model: 'glm-5.3', requests: 3, input_tokens: 10, output_tokens: 20, cache_read_tokens: 30, actual_cost: 0.5 },
          { model: 'kimi-k2.6', requests: 2, input_tokens: 1, output_tokens: 2, cache_creation_tokens: 3, actual_cost: 0.25 },
        ],
      }),
      getUsage: async () => ({ turns: [] }),
    }), 7)

    expect(snapshot.summary).toEqual({
      requests: 5,
      input_tokens: 11,
      output_tokens: 22,
      cache_creation_tokens: 3,
      cache_read_tokens: 30,
      total_tokens: 66,
      actual_cost: 0.75,
    })
  })

  it('prefers the trend endpoint rows over the insights fallback', async () => {
    const snapshot = await tokenUsageGateway(host({
      getUsageDashboardStats: async () => ({}),
      getUsageDashboardModels: async () => ({ models: [] }),
      getUsageDashboardTrend: async () => ({ trend: [{ date: '2026-09-05', total_tokens: 5 }] }),
      getUsageDashboardInsights: async () => ({ daily_trend: [{ date: '2026-09-05', total_tokens: 99 }] }),
      getUsage: async () => ({ turns: [] }),
    }), 30)

    expect(snapshot.timeline).toEqual([{ date: '2026-09-05', total_tokens: 5 }])
  })

  it('names the window it actually asked for', async () => {
    let asked: { startDate?: string; endDate?: string; granularity?: string } = {}
    const snapshot = await tokenUsageGateway(host({
      getUsageDashboardStats: async () => ({}),
      getUsageDashboardModels: async (request: { startDate?: string; endDate?: string }) => {
        asked = request
        return { models: [] }
      },
      getUsageDashboardTrend: async (request: { startDate?: string; endDate?: string; granularity?: string }) => {
        asked = request
        return { trend: [] }
      },
      getUsageDashboardInsights: async () => ({}),
      getUsage: async () => ({ turns: [] }),
    }), 90)

    expect(snapshot.days).toBe(90)
    expect(asked.granularity).toBe('day')
    expect(asked.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(asked.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('asks for hourly buckets on the single-day window', async () => {
    let granularity: string | undefined
    await tokenUsageGateway(host({
      getUsageDashboardStats: async () => ({}),
      getUsageDashboardModels: async () => ({ models: [] }),
      getUsageDashboardTrend: async (request: { granularity?: string }) => {
        granularity = request.granularity
        return { trend: [] }
      },
      getUsageDashboardInsights: async () => ({}),
      getUsage: async () => ({ turns: [] }),
    }), 1)

    expect(granularity).toBe('hour')
  })
})
