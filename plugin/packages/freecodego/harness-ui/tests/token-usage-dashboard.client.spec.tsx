// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TokenUsageDashboard, brandColor, gatewayPoints, gatewayRollup, parseGatewayTime, seriesPalette } from '../src/client/token-usage-dashboard.tsx'
import type { GatewayUsageSnapshot } from '@deepseek-ai/dsh-freecodego-harness-plugin'

/** The three labels a gateway point can carry; tests name them explicitly so a
 *  slice never ends up labelled `undefined`. */
const copy = { others: 'Other models', unknown: 'Unknown model', unattributed: 'Model not attributed' }

afterEach(cleanup)

describe('gateway timestamp parsing', () => {
  it('reads a bare calendar date as that local day, not as UTC midnight', () => {
    // The rollup rows are date-only (`{ date: '2026-09-03' }`), and everything
    // downstream buckets and labels in local time. `Date.parse` reads that form
    // as UTC midnight, so on this machine (UTC+8) it looked right while every
    // user west of UTC saw the feed's day on the previous cell — the assertion
    // is written against local midnight so it fails wherever the UTC reading
    // comes back.
    expect(parseGatewayTime({ date: '2026-09-03' })).toBe(new Date(2026, 8, 3).getTime())
    const parsed = new Date(parseGatewayTime({ date: '2026-09-03' }))
    expect([parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate()]).toEqual([2026, 9, 3])
  })

  it('accepts the documented timeline and turn field names in order', () => {
    expect(parseGatewayTime({ bucket: '2026-09-02' })).toBe(new Date(2026, 8, 2).getTime())
    expect(parseGatewayTime({ bucket_start: '2026-09-01T08:00:00Z' })).toBe(Date.parse('2026-09-01T08:00:00Z'))
    expect(parseGatewayTime({ completed_at: '2026-09-01T09:30:00Z' })).toBe(Date.parse('2026-09-01T09:30:00Z'))
    expect(parseGatewayTime({ created_at: '2026-09-01T10:00:00Z' })).toBe(Date.parse('2026-09-01T10:00:00Z'))
  })

  it('reports missing or malformed timestamps as invalid', () => {
    expect(Number.isNaN(parseGatewayTime({}))).toBe(true)
    expect(Number.isNaN(parseGatewayTime({ date: 'not-a-date' }))).toBe(true)
  })

  it('accepts the settled charges ledger camelCase timestamps', () => {
    expect(parseGatewayTime({ createdAt: '2026-09-05T12:00:00Z' })).toBe(Date.parse('2026-09-05T12:00:00Z'))
    expect(parseGatewayTime({ settledAt: '2026-09-05T13:00:00Z' })).toBe(Date.parse('2026-09-05T13:00:00Z'))
  })
})

describe('gateway trend derivation', () => {
  it('reconciles cost from the charges ledger when the trend endpoint reports none', () => {
    const points = gatewayPoints({
      source: 'freecodego-gateway', fetchedAt: 0, days: 30, status: 'available',
      models: [], timeline: [{ date: '2026-09-03', total_tokens: 0, requests: 0, actual_cost: 0 }],
      charges: [
        { id: 1, amountUSD: 1.25, createdAt: '2026-09-03T10:00:00Z', settledAt: '2026-09-03T10:00:00Z' },
        { id: 2, amountUSD: 0.75, createdAt: '2026-09-04T10:00:00Z', settledAt: '2026-09-04T10:00:00Z' },
      ],
    }, 30, copy)
    expect(points.reduce((sum, point) => sum + point.cost, 0)).toBeCloseTo(2)
    expect(points.reduce((sum, point) => sum + point.tokens, 0)).toBe(0)
  })

  it('keeps healthy trend rows untouched by the charge merge', () => {
    const points = gatewayPoints({
      source: 'freecodego-gateway', fetchedAt: 0, days: 30, status: 'available',
      models: [], timeline: [{ date: '2026-09-03', total_tokens: 300, requests: 3, actual_cost: 1.5 }],
      charges: [{ id: 1, amountUSD: 99, createdAt: '2026-09-03T10:00:00Z', settledAt: '2026-09-03T10:00:00Z' }],
    }, 30, copy)
    // The window is zero-filled so the chart spans all 30 days; the charge
    // merge must not fire on the healthy row.
    expect(points.reduce((sum, point) => sum + point.cost, 0)).toBe(1.5)
    expect(points.reduce((sum, point) => sum + point.tokens, 0)).toBe(300)
  })

  it('builds per-model slices from per-turn records when the trend lacks tokens', () => {
    const points = gatewayPoints({
      source: 'freecodego-gateway', fetchedAt: 0, days: 7, status: 'available',
      models: [], timeline: [],
      turns: [
        { model: 'deepseek-v4-flash', started_at: '2026-09-03T08:00:00Z', input_tokens: 100, output_tokens: 50, cache_read_tokens: 80, cache_creation_tokens: 20, total_tokens: 250, actual_cost: 0.4 },
        { model: 'claude-sonnet-5', completed_at: '2026-09-03T09:00:00Z', input_tokens: 30, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 50, actual_cost: 0.1 },
      ],
    }, 7, copy)
    // Zero-filled window: every day of the span gets a slot, and any data
    // bucket that lands outside the computed span (timezone edge) survives.
    expect(points.length).toBeGreaterThanOrEqual(7)
    const day = points.find(point => point.tokens > 0)
    expect(day?.key).toBe('2026-09-03')
    expect(day?.tokens).toBe(300)
    expect(day?.slices.map(slice => slice.model).sort()).toEqual(['claude-sonnet-5', 'deepseek-v4-flash'])
    expect(day?.slices.find(slice => slice.model === 'deepseek-v4-flash')?.cacheRead).toBe(80)
  })

  it('totals a day from the daily rollup and names the tokens no model row covers', () => {
    // The shipped shape: `daily_trend` reports the token *split* and no
    // `total_tokens`, while `turns` is a bounded sample of the newest requests.
    // Reading only `total_tokens` is what printed `0 tokens` for a day that
    // really carried 2.5M, and totalling turns understated the whole window.
    const points = gatewayPoints({
      source: 'freecodego-gateway', fetchedAt: 0, days: 30, status: 'available',
      models: [],
      dailyTrend: [{ date: '2026-09-05', total_requests: 1327, total_input_tokens: 2_000_000, total_output_tokens: 566_308, total_cache_tokens: 0, total_actual_cost: 0.165 }],
      timeline: [],
      turns: [{ model: 'deepseek-v4-flash', started_at: '2026-09-05T08:00:00Z', total_tokens: 1000, actual_cost: 0.02 }],
    }, 30, copy)

    const day = points.find(point => point.key === '2026-09-05')
    expect(day?.tokens).toBe(2_566_308)
    expect(day?.requests).toBe(1327)
    expect(day?.cost).toBeCloseTo(0.165)
    expect(day?.slices.find(slice => slice.model === 'deepseek-v4-flash')?.tokens).toBe(1000)
    const remainder = day?.slices.find(slice => slice.model === 'Model not attributed')
    expect(remainder?.tokens).toBe(2_565_308)
    expect(remainder?.requests).toBe(1326)
  })

  it('reads one rollup rather than both when two endpoints describe the same days', () => {
    const points = gatewayPoints({
      source: 'freecodego-gateway', fetchedAt: 0, days: 30, status: 'available',
      models: [],
      dailyTrend: [{ date: '2026-09-05', total_tokens: 900, total_requests: 9, total_actual_cost: 1 }],
      timeline: [{ date: '2026-09-05', total_tokens: 900, requests: 9, actual_cost: 1 }],
      turns: [],
    }, 30, copy)
    expect(points.reduce((sum, point) => sum + point.tokens, 0)).toBe(900)
    expect(points.reduce((sum, point) => sum + point.requests, 0)).toBe(9)
    expect(points.reduce((sum, point) => sum + point.cost, 0)).toBe(1)
  })

  it('keeps the chart populated when the endpoint ships no per-turn sample', () => {
    const points = gatewayPoints({
      source: 'freecodego-gateway', fetchedAt: 0, days: 30, status: 'available',
      models: [],
      dailyTrend: [
        { date: '2026-09-04', total_requests: 2, total_input_tokens: 40, total_output_tokens: 60, total_cache_tokens: 0, total_actual_cost: 0.5 },
        { date: '2026-09-05', total_requests: 1, total_input_tokens: 10, total_output_tokens: 0, total_cache_tokens: 0, total_actual_cost: 0.25 },
      ],
      timeline: [],
      turns: [],
    }, 30, copy)
    expect(points.reduce((sum, point) => sum + point.tokens, 0)).toBe(110)
    expect(points.find(point => point.key === '2026-09-04')?.slices.map(slice => slice.model)).toEqual(['Model not attributed'])
  })

  it('exposes the rollup buckets keyed the way the chart buckets them', () => {
    const buckets = gatewayRollup({
      source: 'freecodego-gateway', fetchedAt: 0, days: 1, status: 'available', models: [], timeline: [],
      // A datetime without an offset parses as *local* time, so the expected
      // bucket key below holds in every CI timezone.
      dailyTrend: [{ date: '2026-09-05T08:00:00', total_requests: 4, total_input_tokens: 10, total_output_tokens: 20, total_cache_tokens: 30, total_actual_cost: 0.75 }],
    }, true)
    expect([...buckets.keys()]).toEqual(['2026-09-05 08:00'])
    expect([...buckets.values()][0]).toMatchObject({ tokens: 60, requests: 4, cost: 0.75 })
  })
})

describe('model brand colors', () => {
  it('maps well-known model families to their vendor hue', () => {
    expect(brandColor('deepseek-v4-flash')).toMatch(/#4D6BFE/i)
    expect(brandColor('gpt-5.6-terra')).toMatch(/#10A37F/i)
    expect(brandColor('claude-opus-5')).toMatch(/#D97757/i)
    expect(brandColor('glm-5')).toMatch(/#6E56CF/i)
    expect(brandColor('gemini-3-pro')).toMatch(/#4285F4/i)
  })

  it('hashes unknown models to a stable non-empty color', () => {
    expect(brandColor('totally-unknown-model')).toBe(brandColor('totally-unknown-model'))
    expect(brandColor('totally-unknown-model')).not.toBe('')
  })

  it('anchors a provider on its own brand hue', () => {
    const palette = seriesPalette(['deepseek-v4-pro', 'gpt-5.6-terra', 'claude-sonnet-5'], () => '')
    expect(palette.get('deepseek-v4-pro')).toBe('#4D6BFE')
    expect(palette.get('gpt-5.6-terra')).toBe('#10A37F')
    expect(palette.get('claude-sonnet-5')).toBe('#D97757')
  })

  it('nudges a brand whose blue collides with one already claimed in the window', () => {
    const palette = seriesPalette(['deepseek-v4-pro', 'gemini-3-pro'], () => '')
    expect(palette.get('deepseek-v4-pro')).toBe('#4D6BFE')
    // Google's blue sits only 12° from DeepSeek's, so it moves to a free hue
    // instead of rendering as a second, indistinguishable blue.
    expect(palette.get('gemini-3-pro')).not.toBe('#4285F4')
    expect(palette.get('gemini-3-pro')).toMatch(/^hsl\(/)
  })

  it('keeps every series of one window visibly apart', () => {
    const names = ['deepseek-v4-flash', 'deepseek-v4-pro', 'gpt-5.6-terra', 'claude-sonnet-5', 'gemini-3-pro']
    const palette = seriesPalette(names, () => '')
    const colors = names.map(name => palette.get(name))
    expect(colors.every(color => typeof color === 'string' && color !== '')).toBe(true)
    expect(new Set(colors).size).toBe(names.length)
  })

  it('moves two models of one vendor onto the same hue family, not the same colour', () => {
    const palette = seriesPalette(['deepseek-v4-pro', 'deepseek-v4-flash'], () => '')
    expect(palette.get('deepseek-v4-pro')).toBe('#4D6BFE')
    expect(palette.get('deepseek-v4-flash')).not.toBe('#4D6BFE')
  })

  it('falls back to the row provider when the model id does not name its vendor', () => {
    expect(seriesPalette(['vision-pro'], () => 'anthropic').get('vision-pro')).toBe('#D97757')
  })
})

describe('token usage dashboard rendering', () => {
  const localOk = { ok: true as const, value: {
    source: 'harness-local' as const, generatedAt: 0,
    range: { startAt: Date.parse('2026-09-01T00:00:00'), endAt: Date.parse('2026-09-07T00:00:00'), timezone: 'UTC', granularity: 'day' as const },
    totals: { reportedInputTokens: 10, reportedOutputTokens: 20, reportedCacheReadTokens: 0, reportedCacheWriteTokens: 0, reportedTotalTokens: 30, reportedAttempts: 2, unreportedAttempts: 1, partialAttempts: 0, retryCount: 0, retryDelayMs: 0, failures: [] },
    routes: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash', attempts: 2, inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 30, reportedAttempts: 2, partialAttempts: 0, unreportedAttempts: 0, retries: 0, retryDelayMs: 0, turns: 1 }],
    timeline: [{ startAt: Date.parse('2026-09-03T00:00:00'), endAt: 0, inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 30, attempts: 2, unreportedAttempts: 0 }],
    matrix: [{ date: '2026-09-03', startAt: Date.parse('2026-09-03T00:00:00'), provider: 'deepseek-official', model: 'deepseek-v4-flash', totalTokens: 30, attempts: 2, status: 'reported' as const }],
  } }
  const gatewayOk = { ok: true as const, value: {
    source: 'freecodego-gateway' as const, fetchedAt: 0, days: 30, status: 'available' as const,
    summary: { total_requests: 3, total_tokens: 300, total_actual_cost: 1.5 },
    models: [{ model: 'deepseek-v4-flash', requests: 2, input_tokens: 100, output_tokens: 150, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 250, actual_cost: 1.2 }],
    timeline: [{ date: '2026-09-03', total_tokens: 300, requests: 3, actual_cost: 1.5 }],
    turns: [{ model: 'deepseek-v4-flash', started_at: '2026-09-03T08:00:00Z', input_tokens: 100, output_tokens: 100, cache_read_tokens: 80, cache_creation_tokens: 0, total_tokens: 280, actual_cost: 1.4 }, { model: 'deepseek-v4-flash', completed_at: '2026-09-03T09:00:00Z', input_tokens: 15, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 20, actual_cost: 0.1 }],
  } }

  it('renders the console-style trend chart with window pills and hover tooltip', async () => {
    const { container } = render(<TokenUsageDashboard
      tokenUsageLocal={vi.fn().mockResolvedValue(localOk)}
      tokenUsageGateway={vi.fn().mockResolvedValue(gatewayOk)}
      language="en"
    />)
    // The gateway fetch resolves asynchronously; wait for the chart bars.
    await vi.waitFor(() => { expect(container.querySelectorAll('[class*="tokenChartBar"]').length).toBeGreaterThan(0) })
    expect(container.textContent).toContain('90 days')
    // The selected-window card mirrors the charge-merged model table.
    await vi.waitFor(() => { expect(container.textContent).toContain('$1.20') })
    // Hovering a data-carrying bar opens the tooltip with the exact token
    // count and the per-model breakdown row (empty zero-filled days have no
    // tooltip, so scan until the model row appears).
    const bars = [...container.querySelectorAll('[class*="tokenChartBar"]')]
    expect(bars.length).toBeGreaterThan(1)
    for (const bar of bars) {
      fireEvent.pointerEnter(bar)
      const tip = await vi.waitFor(() => {
        const element = container.querySelector('[class*="tokenChartTip"]')
        return element !== null && element.textContent.includes('deepseek-v4-flash') ? element : null
      }, { timeout: 500 }).catch(() => null)
      if (tip !== null) break
    }
    const tooltip = container.querySelector('[class*="tokenChartTip"]')
    expect(tooltip?.textContent).toContain('deepseek-v4-flash')
    expect(tooltip?.textContent).toContain('300')
  })

  it('totals a settled-only window from the rollup instead of an empty model table', async () => {
    // The live shape this page got wrong: the chart knew about 2.5M tokens on
    // 09-05 while the model table read `0 tokens / 4 requests`, because the
    // backend had already rolled those days into `usage_daily_summaries` and the
    // model endpoint only reads raw request rows.
    const settledOnly = { ok: true as const, value: {
      source: 'freecodego-gateway' as const, fetchedAt: 0, days: 90, status: 'available' as const,
      models: [{ model: 'deepseek-v4-flash', requests: 4, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 0, actual_cost: 0.112 }],
      timeline: [],
      dailyTrend: [{ date: '2026-09-05', total_requests: 1327, total_input_tokens: 2_000_000, total_output_tokens: 566_308, total_cache_tokens: 0, total_actual_cost: 0.165 }],
      turns: [],
    } }
    const { container } = render(<TokenUsageDashboard
      tokenUsageLocal={vi.fn().mockResolvedValue(localOk)}
      tokenUsageGateway={vi.fn().mockResolvedValue(settledOnly)}
      language="en"
    />)

    // The window strip totals the rollup, so the headline agrees with the chart
    // instead of reporting zero next to it.
    await vi.waitFor(() => { expect(container.textContent).toContain('2,566,308') })
    expect(container.textContent).toContain('1,327')
    // The tokens the raw rows cannot name get their own row rather than being
    // dropped from a table that still lists the model they were spent on.
    expect(container.textContent).toContain('Model not attributed')
  })

  it('stacks one segment per model, keeps a hairline model visible and legends them', async () => {
    // Three models on one day, one of them a single token: the ported visual
    // layout must still give it the minimum segment height instead of letting
    // it collapse into the bar's own edge.
    const multiModel = { ok: true as const, value: {
      source: 'freecodego-gateway' as const, fetchedAt: 0, days: 30, status: 'available' as const,
      models: [], timeline: [],
      turns: [
        { model: 'alpha-model', started_at: '2026-09-03T08:00:00Z', input_tokens: 6000, output_tokens: 4000, cache_read_tokens: 5000, cache_creation_tokens: 0, total_tokens: 10000, actual_cost: 1 },
        { model: 'beta-model', started_at: '2026-09-03T09:00:00Z', input_tokens: 2000, output_tokens: 1000, cache_read_tokens: 1000, cache_creation_tokens: 0, total_tokens: 3000, actual_cost: 0.5 },
        { model: 'gamma-model', started_at: '2026-09-03T10:00:00Z', input_tokens: 1, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 1, actual_cost: 0.01 },
      ],
    } }
    const { container } = render(<TokenUsageDashboard
      tokenUsageLocal={vi.fn().mockResolvedValue(localOk)}
      tokenUsageGateway={vi.fn().mockResolvedValue(multiModel)}
      language="en"
    />)
    await vi.waitFor(() => { expect(container.querySelectorAll('[class*="tokenChartSeg"]').length).toBeGreaterThan(0) })
    const bars = [...container.querySelectorAll('[class*="tokenChartBar"]')]
    const bar = bars.find(candidate => candidate.querySelectorAll('[class*="tokenChartSeg"]').length > 1)
    expect(bar).toBeTruthy()
    const segments = [...bar!.querySelectorAll('[class*="tokenChartSeg"]')]
    expect(segments.length).toBe(3)
    // Flush stack: the first segment sits on the baseline and the last one, at
    // the top of the bar, carries the rounded cap.
    expect(Number.parseFloat((segments[0] as HTMLElement).style.bottom)).toBeCloseTo(0)
    expect(segments[segments.length - 1]!.hasAttribute('data-top')).toBe(true)
    // The single-token model is promoted to the 5px floor.
    expect(Number.parseFloat((segments[segments.length - 1] as HTMLElement).style.height)).toBeCloseTo(5)
    // Segments fill their bar with no seam: each one starts exactly where the
    // one below it ends, and the stack closes on the bar's own top edge.
    const boxes = segments.map(segment => ({ bottom: Number.parseFloat((segment as HTMLElement).style.bottom), height: Number.parseFloat((segment as HTMLElement).style.height) }))
    const stack = boxes.reduce((sum, box) => sum + box.height, 0)
    expect(stack).toBeCloseTo(Number.parseFloat((bar as HTMLElement).style.height), 0)
    boxes.forEach((box, index) => {
      const lower = boxes[index - 1]
      if (lower === undefined) return
      expect(box.bottom).toBeCloseTo(lower.bottom + lower.height, 2)
    })
    const legend = container.querySelector('[class*="tokenChartLegend"]')
    expect(legend?.textContent).toContain('alpha-model')
    expect(legend?.textContent).toContain('beta-model')
    expect(legend?.textContent).toContain('gamma-model')
  })

  it('scales the segment floor down on a short bar so no model is clipped away', async () => {
    // One tall day sets the rail; a quiet day beside it is only a few pixels
    // tall. Holding the 5px floor there would push the upper models past the
    // bar's cap, so the floor has to yield and keep every colour a sliver.
    const mixed = { ok: true as const, value: {
      source: 'freecodego-gateway' as const, fetchedAt: 0, days: 30, status: 'available' as const,
      models: [], timeline: [],
      turns: [
        { model: 'alpha-model', started_at: '2026-09-03T08:00:00Z', total_tokens: 10000, actual_cost: 1 },
        { model: 'beta-model', started_at: '2026-09-03T09:00:00Z', total_tokens: 3000, actual_cost: 0.5 },
        { model: 'gamma-model', started_at: '2026-09-03T10:00:00Z', total_tokens: 1, actual_cost: 0.01 },
        { model: 'alpha-model', started_at: '2026-09-04T08:00:00Z', total_tokens: 150, actual_cost: 0.01 },
        { model: 'beta-model', started_at: '2026-09-04T09:00:00Z', total_tokens: 100, actual_cost: 0.01 },
        { model: 'gamma-model', started_at: '2026-09-04T10:00:00Z', total_tokens: 50, actual_cost: 0.01 },
      ],
    } }
    const { container } = render(<TokenUsageDashboard
      tokenUsageLocal={vi.fn().mockResolvedValue(localOk)}
      tokenUsageGateway={vi.fn().mockResolvedValue(mixed)}
      language="en"
    />)
    await vi.waitFor(() => { expect(container.querySelectorAll('[class*="tokenChartSeg"]').length).toBeGreaterThan(0) })
    const shortBar = [...container.querySelectorAll('[class*="tokenChartBar"]')]
      .map(bar => ({ bar, height: Number.parseFloat((bar as HTMLElement).style.height) }))
      .find(candidate => candidate.height > 0 && candidate.height < 20)
    expect(shortBar).toBeTruthy()
    const segments = [...shortBar!.bar.querySelectorAll('[class*="tokenChartSeg"]')].map(segment => Number.parseFloat((segment as HTMLElement).style.height))
    expect(segments.length).toBe(3)
    // Every model survives, and the stack still fills the short bar exactly.
    expect(Math.min(...segments)).toBeGreaterThan(0)
    expect(segments.reduce((sum, height) => sum + height, 0)).toBeCloseTo(shortBar!.height, 1)
  })

  it('renders the today window as 24 hourly buckets with hour labels', async () => {
    const { container } = render(<TokenUsageDashboard
      tokenUsageLocal={vi.fn().mockResolvedValue(localOk)}
      tokenUsageGateway={vi.fn().mockResolvedValue(gatewayOk)}
      language="en"
    />)
    await vi.waitFor(() => { expect(container.querySelectorAll('[class*="tokenChartBar"]').length).toBeGreaterThan(0) })
    const today = [...container.querySelectorAll('button')].find(button => button.textContent === 'Today')
    expect(today).toBeTruthy()
    today!.click()
    await vi.waitFor(() => { expect(container.textContent).toContain('Hourly usage') })
    // One bucket per hour of the day, not one per day of the window.
    expect(container.querySelectorAll('[class*="tokenChartBar"]').length).toBe(24)
    const axis = container.querySelector('[class*="tokenChartAxis"]')
    expect(axis?.textContent).toContain('00:00')
    expect(axis?.textContent).toContain('23:00')
  })

  it('renders the selected window from its own cache, not the window it replaced', async () => {
    // The per-window cache was read only to decide `busy`: a hit never seeded
    // the seat, so a window the component had already fetched came back as the
    // series of the window that replaced it — the opposite of the
    // stale-while-revalidate the cache exists for. The second 30-day call never
    // resolves, so the revalidation cannot mask which series was rendered.
    const pending = new Promise<never>(() => {})
    const snapshot = (days: number, tokens: number): GatewayUsageSnapshot => ({
      source: 'freecodego-gateway', fetchedAt: 0, days, status: 'available', models: [], timeline: [],
      turns: [{ model: 'alpha-model', started_at: new Date().toISOString(), total_tokens: tokens, actual_cost: 0 }],
    })
    let thirtyDayCalls = 0
    const tokenUsageGateway = vi.fn((days: number) => {
      if (days === 1) return Promise.resolve({ ok: true as const, value: snapshot(1, 7) })
      return thirtyDayCalls++ === 0
        ? Promise.resolve({ ok: true as const, value: snapshot(30, 300) })
        : pending
    })
    const { container } = render(<TokenUsageDashboard tokenUsageLocal={vi.fn().mockResolvedValue(localOk)} tokenUsageGateway={tokenUsageGateway} language="en" />)
    const headline = (): string | null | undefined => container.querySelector('[class*="tokenChartTotal"]')?.textContent
    const pill = (label: string): HTMLButtonElement => [...container.querySelectorAll('button')].find(button => button.textContent === label) as HTMLButtonElement
    await vi.waitFor(() => { expect(headline()).toContain('300') })
    // Today resolves on its own, so the seat must settle on the 1-day figure.
    pill('Today').click()
    await vi.waitFor(() => { expect(headline()).toContain('7') })
    // Back to the cached window: it must render at once, and must not keep
    // showing the 1-day series that replaced it.
    pill('30 days').click()
    await vi.waitFor(() => { expect(headline()).toContain('300') })
  })

  it('re-reads the window on screen when the panel is refreshed', async () => {
    // The Refresh copy shipped in both locales, and both snapshot effects listed
    // `refresh` as a dependency, while nothing rendered a control: the only way
    // to re-read the ledger was switching a range pill off and back. The control
    // re-reads the selected window rather than jumping to another one.
    const tokenUsageGateway = vi.fn().mockResolvedValue(gatewayOk)
    const { container } = render(<TokenUsageDashboard tokenUsageLocal={vi.fn().mockResolvedValue(localOk)} tokenUsageGateway={tokenUsageGateway} language="en" />)
    await vi.waitFor(() => { expect(tokenUsageGateway).toHaveBeenCalledTimes(1) })
    const today = [...container.querySelectorAll('button')].find(button => button.textContent === 'Today')
    expect(today).toBeTruthy()
    today!.click()
    await vi.waitFor(() => { expect(tokenUsageGateway).toHaveBeenCalledTimes(2) })
    const refresh = [...container.querySelectorAll('button')].find(button => button.textContent === 'Refresh')
    expect(refresh).toBeTruthy()
    refresh!.click()
    await vi.waitFor(() => { expect(tokenUsageGateway).toHaveBeenCalledTimes(3) })
    expect(tokenUsageGateway.mock.calls[2]).toEqual([1])
  })

  it('shows a status notice when the gateway errors instead of silent zeros', async () => {
    const { container } = render(<TokenUsageDashboard
      tokenUsageLocal={vi.fn().mockResolvedValue(localOk)}
      tokenUsageGateway={vi.fn().mockResolvedValue({ ok: true as const, value: { source: 'freecodego-gateway' as const, fetchedAt: 0, days: 30, status: 'error' as const, models: [], timeline: [], message: 'upstream timeout' } })}
      language="en"
    />)
    await vi.waitFor(() => { expect(container.textContent).toContain('upstream timeout') })
  })

  it('shows the signed-out hint instead of a fake balance', () => {
    const { container } = render(<TokenUsageDashboard
      tokenUsageLocal={vi.fn().mockResolvedValue(localOk)}
      tokenUsageGateway={vi.fn().mockResolvedValue(gatewayOk)}
      language="en"
    />)
    expect(container.textContent).toContain('Sign in')
  })

  it('renders the balance strip with a level when signed in', async () => {
    const { container } = render(<TokenUsageDashboard
      tokenUsageLocal={vi.fn().mockResolvedValue(localOk)}
      tokenUsageGateway={vi.fn().mockResolvedValue(gatewayOk)}
      accountStatus={vi.fn().mockResolvedValue({ ok: true as const, value: { status: 'authenticated', user: { balance: 12.5 } } })}
      language="en"
    />)
    await vi.waitFor(() => { expect(container.querySelector('[data-level="ok"]')).toBeTruthy() })
    expect(container.textContent).toContain('$12.50')
  })

  it('marks local model rows without tokens as unreported', async () => {
    const { container } = render(<TokenUsageDashboard
      tokenUsageLocal={vi.fn().mockResolvedValue(localOk)}
      tokenUsageGateway={vi.fn().mockResolvedValue(gatewayOk)}
      language="en"
    />)
    await vi.waitFor(() => { expect(container.textContent).toContain('Local Harness usage') })
    // Switch to the local tab and confirm the status column rendering.
    const localTab = [...container.querySelectorAll('button')].find(button => button.textContent === 'Local Harness usage')
    localTab?.click()
    await vi.waitFor(() => { expect(container.textContent).toContain('Reported') })
  })

  it('names the model rows the rollup cannot attribute instead of leaving them blank', async () => {
    // The per-model rollup carries one row per model, and a request that arrived
    // without a model name lands in a blank-named row. Rendering that verbatim
    // put an empty cell under a 4.7M-token chart — the "everything is unknown"
    // report this page started from — so the row takes the localized label and
    // the tokens no model row covers get their own line.
    const unnamed = { ok: true as const, value: {
      source: 'freecodego-gateway' as const, fetchedAt: 0, days: 30, status: 'available' as const,
      models: [
        { model: '', provider: 'logfare', requests: 3, total_tokens: 100, actual_cost: 0.1 },
        { model: 'glm-5.3', provider: 'logfare', requests: 2, total_tokens: 200, actual_cost: 0.2 },
      ],
      timeline: [],
      dailyTrend: [{ date: '2026-09-05', total_requests: 10, total_input_tokens: 3000, total_output_tokens: 0, total_cache_tokens: 0, total_actual_cost: 0.3 }],
    } }
    const { container } = render(<TokenUsageDashboard
      tokenUsageLocal={vi.fn().mockResolvedValue(localOk)}
      tokenUsageGateway={vi.fn().mockResolvedValue(unnamed)}
      language="en"
    />)
    await vi.waitFor(() => { expect(container.textContent).toContain('glm-5.3') })
    const table = container.querySelector('[class*="tokenGatewayTable"]')
    expect(table?.textContent).toContain('Unknown model')
    // 3000 rolled-up tokens minus the 300 the named model rows account for.
    const remainder = [...table!.querySelectorAll('tr')].find(row => row.textContent?.includes('Model not attributed'))
    expect(remainder?.textContent).toContain('2.7K')
  })

  const localWaste = {
    ok: true as const,
    value: {
      ...localOk.value,
      totals: {
        ...localOk.value.totals,
        cacheWaste: {
          missedTokens: 3_072, missedCostUsd: 0, missCount: 2, comparedTurns: 5, unattributableTurns: 1, pricedTurns: 0,
          byCause: { idleGap: 1, modelChanged: 0, prefixChanged: 1 },
          worst: [
            { at: 1_700_000_000_000, model: 'freecodego/deepseek-v4-flash', missedTokens: 3_000, missedCostUsd: 0, cause: 'prefix-changed' as const },
            { at: 1_700_000_060_000, model: 'freecodego/deepseek-v4-flash', missedTokens: 72, missedCostUsd: 0, cause: 'idle-gap' as const },
          ],
        },
      },
    },
  }

  const openLocalTab = async (container: HTMLElement): Promise<void> => {
    await vi.waitFor(() => { expect(container.textContent).toContain('Local Harness usage') })
    const localTab = [...container.querySelectorAll('button')].find(button => button.textContent === 'Local Harness usage')
    localTab?.click()
    await vi.waitFor(() => { expect(container.textContent).toContain('Reported') })
  }

  it('attributes re-billed prompt tokens with their cause on the local tab', async () => {
    const { container } = render(<TokenUsageDashboard
      tokenUsageLocal={vi.fn().mockResolvedValue(localWaste)}
      tokenUsageGateway={vi.fn().mockResolvedValue(gatewayOk)}
      language="en"
    />)
    await openLocalTab(container)
    // The headline number has to be the missed tokens, not the input total: a
    // large input total is produced by real work *and* by re-billing, and only
    // this figure separates them.
    expect(container.textContent).toContain('Why the cache missed')
    await vi.waitFor(() => { expect(container.textContent).toContain('3.1K') })
    expect(container.querySelectorAll('[data-cause="prefix-changed"]').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('[data-cause="idle-gap"]').length).toBeGreaterThan(0)
    expect(container.textContent).toContain('request prefix changed')
    // No pricing reached the ledger, so the panel says tokens only rather than
    // rendering a fabricated $0.00 saving.
    expect(container.textContent).toContain('no dollar figure is invented')
  })

  it('stays absent — not zero — when the range has no cache attribution', async () => {
    const { container } = render(<TokenUsageDashboard
      tokenUsageLocal={vi.fn().mockResolvedValue(localOk)}
      tokenUsageGateway={vi.fn().mockResolvedValue(gatewayOk)}
      language="en"
    />)
    await openLocalTab(container)
    // "We cannot see this provider's cache" and "it wasted nothing" are opposite
    // conclusions, so an absent block must not render as a clean bill of health.
    expect(container.textContent).not.toContain('Why the cache missed')
  })

  it('never shows cache waste on the gateway tab', async () => {
    const { container } = render(<TokenUsageDashboard
      tokenUsageLocal={vi.fn().mockResolvedValue(localWaste)}
      tokenUsageGateway={vi.fn().mockResolvedValue(gatewayOk)}
      language="en"
    />)
    await vi.waitFor(() => { expect(container.textContent).toContain('FreeCodeGo gateway billing') })
    // The gateway endpoint reports billing totals, not per-turn prefixes, so the
    // block must not claim a gateway account wasted nothing.
    expect(container.textContent).not.toContain('Why the cache missed')
  })
})

describe('fillWindow DST correctness', () => {
  // A fixed-millisecond stride lands on the same wall-clock date across a
  // DST fall-back: the bucket is zero-filled twice, double-counting every
  // window card and handing React duplicate keys. These tests span the
  // 2026-11-01 US fall-back (a 25-hour day) by setting the runner's TZ, so
  // they reproduce regardless of the CI machine's own timezone.
  const originalTz = process.env.TZ
  afterEach(() => { vi.useRealTimers(); process.env.TZ = originalTz })

  it('zero-fills each calendar day exactly once across a DST fall-back', () => {
    process.env.TZ = 'America/New_York'
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 3, 12, 0, 0)) // Nov 3 2026, after the fall-back
    const points = gatewayPoints({
      source: 'freecodego-gateway', fetchedAt: 0, days: 30, status: 'available',
      models: [], timeline: [{ date: '2026-10-20', total_tokens: 300, requests: 3, actual_cost: 1.5 }],
      charges: [],
    }, 30, copy)
    const keys = points.map(point => point.key)
    expect(keys.length).toBe(30)
    expect(new Set(keys).size).toBe(keys.length)
    expect(points.reduce((sum, point) => sum + point.tokens, 0)).toBe(300)
  })

  it('zero-fills each wall-clock hour exactly once across a DST fall-back', () => {
    process.env.TZ = 'America/New_York'
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 1, 9, 0, 0)) // Nov 1 2026, the 25-hour day itself
    const points = gatewayPoints({
      source: 'freecodego-gateway', fetchedAt: 0, days: 1, status: 'available',
      models: [], timeline: [], charges: [],
    }, 1, copy)
    const keys = points.map(point => point.key)
    expect(keys.length).toBe(24)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
