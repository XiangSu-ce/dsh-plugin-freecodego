// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { collapseModelLabels, MODEL_TAG_LIMIT, ProviderCard, uniqueModelLabels } from '../src/client/provider-card.tsx'
import { ProviderModelVisibility, samePickerModels, uniquePickerModels } from '../src/client/provider-model-visibility.tsx'
import { isModelVisible, readModelPickerVisibility } from '../src/client/model-picker-visibility.ts'

afterEach(() => {
  cleanup()
  // The panel persists to `localStorage`, which jsdom keeps for the whole file:
  // one case's refusal would hide a provider in the next one.
  globalThis.localStorage.clear()
})

describe('provider card model cloud', () => {
  it('holds nothing back when the list fits', () => {
    const result = collapseModelLabels(['a', 'b', 'c'])
    expect(result.visible).toEqual(['a', 'b', 'c'])
    expect(result.hiddenCount).toBe(0)
  })

  it('slices at the limit and reports the remainder', () => {
    const models = Array.from({ length: 10 }, (_, index) => `m${index}`)
    const result = collapseModelLabels(models)
    expect(result.visible).toHaveLength(MODEL_TAG_LIMIT)
    expect(result.visible).toEqual(models.slice(0, MODEL_TAG_LIMIT))
    expect(result.hiddenCount).toBe(10 - MODEL_TAG_LIMIT)
  })

  it('hides everything for a zero limit instead of silently showing one', () => {
    expect(collapseModelLabels(['a', 'b'], 0)).toEqual({ visible: [], hiddenCount: 2 })
  })

  it('drops blanks and duplicates while keeping order', () => {
    // Providers repeat display names across tiers (logfare `auto` appears in
    // both the standard and premium projections), so an undeduped cloud would
    // render the same tag twice.
    expect(uniqueModelLabels(['GLM 5.3', '  ', 'GLM 5.3', 'Auto', ' Auto '])).toEqual(['GLM 5.3', 'Auto'])
  })
})

describe('provider card rendering', () => {
  const base = { name: 'logfare', title: 'Free models', status: { label: 'Connected', tone: 'live' as const }, language: 'en' as const }

  it('renders no cloud at all when the provider offers no models', () => {
    // A failed directory fetch yields an empty list. That must read as "no
    // models to show", never as an empty box or a "0 models" control.
    const { container } = render(<ProviderCard {...base} models={[]} />)
    expect(container.querySelectorAll('[class*="tag"]').length).toBe(0)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers an expander only when some models are held back', () => {
    const { rerender } = render(<ProviderCard {...base} models={['a', 'b']} />)
    expect(screen.queryByRole('button')).toBeNull()
    rerender(<ProviderCard {...base} models={['a', 'b', 'c', 'd', 'e', 'f', 'g']} />)
    const toggle = screen.getByRole('button')
    expect(toggle.textContent).toContain('7')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('g')).toBeTruthy()
  })

  it('states the live model names it was given rather than any built-in roster', () => {
    render(<ProviderCard {...base} models={['Gemma 4 26B', 'Kimi K2.7 Code']} />)
    expect(screen.getByText('Gemma 4 26B')).toBeTruthy()
    expect(screen.getByText('Kimi K2.7 Code')).toBeTruthy()
  })

  it('marks each status tone distinctly so the dot can be styled', () => {
    for (const tone of ['live', 'warn', 'idle'] as const) {
      const { container, unmount } = render(<ProviderCard {...base} status={{ label: tone, tone }} />)
      expect(container.querySelector(`[data-tone="${tone}"]`)).toBeTruthy()
      unmount()
    }
  })

  it('omits the summary line when the caller has no live fact to state', () => {
    const { container } = render(<ProviderCard {...base} />)
    expect(container.querySelector('[class*="summary"]')).toBeNull()
  })

  it('renders the provider controls slot between the account body and the actions', () => {
    // Order matters in one direction only: the card's own buttons must keep the
    // bottom edge, so a secondary settings block never buries them.
    const { container } = render(<ProviderCard
      {...base}
      actions={<button type="button">Save key</button>}
      children={<span>account body</span>}
      visibility={<span data-testid="visibility">panel</span>}
    />)
    const order = [...container.querySelectorAll('span, button')].map(node => node.textContent)
    expect(order.indexOf('account body')).toBeLessThan(order.indexOf('panel'))
    expect(order.indexOf('panel')).toBeLessThan(order.indexOf('Save key'))
  })
})

describe('provider model visibility panel', () => {
  // The rows arrive through a reader: the session directory can land after this
  // panel mounted, so the panel looks again instead of caching the first answer.
  const base = { language: 'en' as const, models: () => [{ id: 'wb-free', label: 'WorkBuddy Free' }, { id: 'wb-pro', label: 'WorkBuddy Pro' }] }
  // The panel is folded to its settings button; every case below opens it the
  // way a user does, which is also the only way the controls are reachable.
  const expand = (): void => { fireEvent.click(screen.getByRole('button', { name: /Model list visibility|模型列表显示设置/u })) }

  it('keeps the checklist folded until the settings button is pressed', () => {
    // The whole point of folding: an always-open checklist made every provider
    // card tall enough to bury the next one, and most users never change this.
    render(<ProviderModelVisibility provider="workbuddy" {...base} />)
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    const toggle = screen.getByRole('button')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('checkbox')).toHaveLength(3)
  })

  it('defaults to showing the provider and every model, free ones included', () => {
    render(<ProviderModelVisibility provider="workbuddy" {...base} />)
    expand()
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes).toHaveLength(3)
    expect(boxes.every(box => box.checked)).toBe(true)
    // WorkBuddy's routes are free, so the provider's rows carry the tag; the
    // workbuddy card is the one place that fact is stated.
    expect(screen.getAllByText('free')).toHaveLength(2)
  })

  it('starts a curated provider with only its default rows checked', () => {
    render(<ProviderModelVisibility provider="vyce" language="en" models={() => [
      { id: 'vyce/deepseek-v4.1', label: 'DeepSeek V4.1' },
      { id: 'vyce/qwen3.8-flash', label: 'Qwen 3.8 Flash' },
      { id: 'vyce/glm-5.3', label: 'GLM 5.3' },
    ]} />)
    expand()
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes.map(box => box.checked)).toEqual([true, true, true, false])
    // The folded button still states what is switched off.
    expect(screen.getByText('1 hidden')).toBeTruthy()
  })

  it('writes a provider-level refusal that the picker can read back', () => {
    render(<ProviderModelVisibility provider="workbuddy" {...base} />)
    expand()
    const master = screen.getAllByRole('checkbox')[0] as HTMLInputElement
    fireEvent.click(master)
    expect(readModelPickerVisibility().providers).toEqual({ workbuddy: false })
    expect(isModelVisible(readModelPickerVisibility(), 'workbuddy', 'wb-free')).toBe(false)
  })

  it('writes one decision per model and folds the gateway\u2019s per-group rows', () => {
    render(<ProviderModelVisibility
      provider="freecodego"
      language="en"
      models={() => [{ id: 'claude-fable-5@group:4', label: 'claude fable 5' }, { id: 'claude-fable-5@group:7', label: 'claude fable 5' }]}
    />)
    expand()
    // One checkbox for both group rows: the name is what the user recognises,
    // and the stored decision covers every group of it.
    expect(screen.getAllByText('claude fable 5')).toHaveLength(1)
    const model = screen.getAllByRole('checkbox')[1] as HTMLInputElement
    fireEvent.click(model)
    expect(readModelPickerVisibility().models).toEqual({ 'freecodego\u0000claude-fable-5': false })
    expect(isModelVisible(readModelPickerVisibility(), 'freecodego', 'claude-fable-5@group:7')).toBe(false)
  })

  it('hides and restores a whole roster in one pass', () => {
    render(<ProviderModelVisibility provider="workbuddy" {...base} />)
    expand()
    fireEvent.click(screen.getByText('None'))
    expect(readModelPickerVisibility().models).toEqual({ 'workbuddy\u0000wb-free': false, 'workbuddy\u0000wb-pro': false })
    fireEvent.click(screen.getByText('All'))
    expect(readModelPickerVisibility().models).toEqual({})
  })

  it('renders the switch alone while the provider has no directory yet', () => {
    render(<ProviderModelVisibility provider="cline" language="zh" models={() => []} />)
    expand()
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
    expect(screen.queryByText('全选')).toBeNull()
    expect(screen.getByText(/尚未取得该提供商的模型目录/u)).toBeTruthy()
  })

  it('fills the checklist in when the directory lands after the panel mounted', async () => {
    // This is the real sequence on a cold page: the settings tab renders while
    // the session directory is still loading, so an empty answer is not final.
    let rows: readonly { id: string; label: string }[] = []
    render(<ProviderModelVisibility provider="cline" language="en" models={() => rows} />)
    expand()
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
    rows = [{ id: 'cline-free', label: 'Cline Free' }]
    await waitFor(() => { expect(screen.getByText('Cline Free')).toBeTruthy() }, { timeout: 3_000 })
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
  })

  it('folds duplicate group rows and reports a stable roster', () => {
    const rows = [{ id: 'a@group:1', label: 'A' }, { id: 'a@group:2', label: 'A' }, { id: 'b', label: 'B' }]
    expect(uniquePickerModels(rows)).toEqual([{ id: 'a@group:1', label: 'A' }, { id: 'b', label: 'B' }])
    expect(samePickerModels(uniquePickerModels(rows), uniquePickerModels(rows))).toBe(true)
    expect(samePickerModels(uniquePickerModels(rows), uniquePickerModels([...rows, { id: 'c', label: 'C' }]))).toBe(false)
  })
})
