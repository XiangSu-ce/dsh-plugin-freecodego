// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { collapseModelLabels, MODEL_TAG_LIMIT, ProviderCard, uniqueModelLabels } from '../src/client/provider-card.tsx'

afterEach(cleanup)

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
})
