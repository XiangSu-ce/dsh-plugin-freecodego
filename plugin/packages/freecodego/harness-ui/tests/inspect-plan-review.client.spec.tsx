// @vitest-environment jsdom
/**
 * The two surfaces that wired the last three user-facing Remotes.
 *
 * What these tests defend is not that markup renders, but the three invariants
 * the Host's contracts make load-bearing:
 *
 *  - a section that could not be collected renders as its *reason*, because
 *    "nothing configured" and "the config was unreadable" are the same JSON;
 *  - a remark is addressed by the line numbers `planReviewOpen` printed, because
 *    a remark that lands on another line is worse than no remark;
 *  - `planReviewCompose` refuses an unusable submission with a *successful* call
 *    carrying `rejected`, so a panel that reads only `result.ok` reports a
 *    refusal as a compose that silently produced nothing.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { InspectPanel, PlanReviewOverlay } from '../src/client/settings-tab.tsx'

afterEach(cleanup)

type InspectProps = Parameters<typeof InspectPanel>[0]
type PlanReviewProps = Parameters<typeof PlanReviewOverlay>[0]

const report = (overrides: Partial<{ unavailable: readonly string[] }> = {}) => ({
  generatedAt: 1_700_000_000_000,
  unavailable: overrides.unavailable ?? [],
  sections: [
    { id: 'trust', title: 'Folder trust', status: 'ok' as const, data: { entries: 2, enabled: true } },
    { id: 'skills', title: 'Skills', status: 'ok' as const, data: [{ name: 'a' }, { name: 'b' }] },
    { id: 'mcp', title: 'MCP servers', status: 'unavailable' as const, reason: 'the MCP config was unreadable', data: null },
  ],
})

const surface = (overrides: Partial<{ empty: boolean; body: string; warnings: readonly string[] }> = {}) => {
  const body = overrides.body ?? 'intro line\nsecond line\nthird line\nfourth line\n'
  return {
    empty: overrides.empty ?? false,
    body,
    lineCount: body.split('\n').length,
    path: '/state/plan.md',
    missingSections: [],
    emptySections: [],
    warnings: overrides.warnings ?? [],
  }
}

function setupInspect(overrides: Partial<InspectProps> = {}): InspectProps {
  const props: InspectProps = { report: vi.fn(async () => ({ ok: true as const, value: report() })), ...overrides }
  render(<InspectPanel {...props} />)
  return props
}

function setupPlanReview(overrides: Partial<PlanReviewProps> = {}): PlanReviewProps {
  const props: PlanReviewProps = {
    open: vi.fn(async () => ({ ok: true as const, value: surface() })),
    compose: vi.fn(async () => ({ ok: true as const, value: { message: 'The plan at /state/plan.md needs changes before it can be approved.' } })),
    currentSessionId: () => 'session-1',
    ...overrides,
  }
  render(<PlanReviewOverlay {...props} />)
  return props
}

describe('InspectPanel', () => {
  it('reads the report on mount and names every section the Host collected', async () => {
    const props = setupInspect()
    expect(await screen.findByText('Folder trust')).toBeTruthy()
    expect(screen.getByText('Skills')).toBeTruthy()
    // The summary is derived from the payload rather than left blank: a section
    // that collected nothing must not look like one that was never collected.
    expect(screen.getByText('entries=2')).toBeTruthy()
    expect(screen.getByText('2 项')).toBeTruthy()
    expect(props.report).toHaveBeenCalledTimes(1)
  })

  it('renders a section that could not be collected as its reason, not as an empty row', async () => {
    setupInspect({ report: vi.fn(async () => ({ ok: true as const, value: report({ unavailable: ['mcp'] }) })) })
    // The count first, so the holes are visible before the payloads.
    expect(await screen.findByText(/其中 mcp 收集失败/u)).toBeTruthy()
    expect(screen.getByText(/不可读：the MCP config was unreadable/u)).toBeTruthy()
    expect(screen.getByText('1 个面不可读')).toBeTruthy()
  })

  it('surfaces a Host failure as an alert and keeps the panel', async () => {
    setupInspect({ report: vi.fn(async () => ({ ok: false as const, error: new RemoteError('gateway/internal', 'inspect collection failed', {}) })) })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText(/inspect collection failed/u)).toBeTruthy()
  })

  it('renders nothing when the Host does not declare the Remote', () => {
    const { container } = render(<InspectPanel />)
    expect(container.textContent).toBe('')
  })
})

describe('PlanReviewOverlay', () => {
  it('opens the numbered plan surface for the current session', async () => {
    const props = setupPlanReview()
    fireEvent.click(screen.getByLabelText('open-plan-review'))
    expect(await screen.findByText('second line')).toBeTruthy()
    // Line numbers are the ones the Host printed, so a remark can address them.
    expect(screen.getByLabelText('plan-line-1').textContent).toContain('intro line')
    expect(screen.getByLabelText('plan-line-4').textContent).toContain('fourth line')
    expect(props.open).toHaveBeenCalledWith('session-1')
  })

  it('shows the section warnings the surface carried', async () => {
    setupPlanReview({ open: vi.fn(async () => ({ ok: true as const, value: { ...surface(), missingSections: ['Rollout'], warnings: ['no test section'] } })) })
    fireEvent.click(screen.getByLabelText('open-plan-review'))
    expect(await screen.findByText('缺少小节：Rollout')).toBeTruthy()
    expect(screen.getByText('no test section')).toBeTruthy()
  })

  it('says an absent plan is still reviewable rather than rendering an empty surface', async () => {
    setupPlanReview({ open: vi.fn(async () => ({ ok: true as const, value: surface({ empty: true, body: 'No plan has been written yet.' }) })) })
    fireEvent.click(screen.getByLabelText('open-plan-review'))
    expect(await screen.findByText(/还没有方案/u)).toBeTruthy()
  })

  it('sends the selected line range and the remark to planReviewCompose', async () => {
    const props = setupPlanReview()
    fireEvent.click(screen.getByLabelText('open-plan-review'))
    fireEvent.click(await screen.findByLabelText('plan-line-2'))
    fireEvent.click(screen.getByLabelText('plan-line-4'))
    expect(screen.getByText('已选第 2–4 行')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('remark-text'), { target: { value: 'the helper already exists' } })
    fireEvent.click(screen.getByLabelText('add-remark'))
    fireEvent.click(screen.getByLabelText('compose-rework'))
    await waitFor(() => {
      expect(props.compose).toHaveBeenCalledWith({
        sessionId: 'session-1',
        comments: [{ startLine: 2, endLine: 4, text: 'the helper already exists' }],
      })
    })
    expect(await screen.findByText(/needs changes before it can be approved/u)).toBeTruthy()
  })

  it('passes the overall note through and never invents a blank one', async () => {
    const props = setupPlanReview()
    fireEvent.click(screen.getByLabelText('open-plan-review'))
    fireEvent.change(await screen.findByLabelText('review-notes'), { target: { value: '  split this into two plans  ' } })
    fireEvent.click(screen.getByLabelText('compose-rework'))
    await waitFor(() => {
      expect(props.compose).toHaveBeenCalledWith({ sessionId: 'session-1', comments: [], notes: 'split this into two plans' })
    })
  })

  it('shows a refusal as a refusal instead of a compose that produced nothing', async () => {
    // A rejection arrives as `ok: true` carrying `rejected`, which is exactly the
    // shape a panel that reads only `result.ok` reports as success.
    setupPlanReview({
      compose: vi.fn(async () => ({ ok: true as const, value: { rejected: 'a rework request needs at least one comment or a note' } })),
    })
    fireEvent.click(screen.getByLabelText('open-plan-review'))
    fireEvent.change(await screen.findByLabelText('review-notes'), { target: { value: 'note' } })
    fireEvent.click(screen.getByLabelText('compose-rework'))
    expect(await screen.findByText(/返工请求未被接受：a rework request needs at least one comment or a note/u)).toBeTruthy()
  })

  it('cannot compose from an empty submission', async () => {
    const props = setupPlanReview()
    fireEvent.click(screen.getByLabelText('open-plan-review'))
    await screen.findByText('second line')
    const submit = screen.getByLabelText('compose-rework') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    expect(props.compose).not.toHaveBeenCalled()
  })

  it('reports a missing session instead of calling a Remote with no plan to address', async () => {
    const props = setupPlanReview({ currentSessionId: () => undefined })
    fireEvent.click(screen.getByLabelText('open-plan-review'))
    expect(await screen.findByText(/打开一个绑定工作区的会话后才能复核方案/u)).toBeTruthy()
    expect(props.open).not.toHaveBeenCalled()
  })

  it('renders nothing when the Host does not declare the Remote', () => {
    const { container } = render(<PlanReviewOverlay currentSessionId={() => 'session-1'} />)
    expect(container.textContent).toBe('')
  })
})
