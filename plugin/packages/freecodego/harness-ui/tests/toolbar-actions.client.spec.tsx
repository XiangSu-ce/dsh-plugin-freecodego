// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EngineAction } from '../src/client/toolbar-actions.tsx'

afterEach(cleanup)

describe('EngineAction', () => {
  it('notifies when an existing session changes the new-session engine', async () => {
    const t = (key: string): string => ({
      engineHint: 'Choose the engine for new sessions',
      engineShort: 'Engine',
      engineDeepseek: 'DeepSeek',
      engineCodex: 'Codex',
      engineClaude: 'Claude',
      engineSwitchTitle: 'Current session engine is fixed',
      engineSwitchHint: 'This change applies only to new sessions.',
      engineSwitchDismiss: 'Dismiss engine switch notice',
    }[key] ?? key)
    const setDefaultEngine = vi.fn().mockResolvedValue({ ok: true as const })
    render(<EngineAction
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [{ id: 'deepseek', availability: 'available' }, { id: 'codex', availability: 'available' }, { id: 'claude', availability: 'available' }] } })}
      setDefaultEngine={setDefaultEngine}
      sessionId="session-1"
      t={t as never}
    />)

    const select = await screen.findByRole('combobox')
    fireEvent.change(select, { target: { value: 'claude' } })

    await waitFor(() => { expect(setDefaultEngine).toHaveBeenCalledWith('claude') })
    expect(await screen.findByText('Current session engine is fixed')).toBeTruthy()
    expect(screen.getByText('This change applies only to new sessions.')).toBeTruthy()
  })

  it('does not notify when a blank session selects its first engine', async () => {
    const t = (key: string): string => ({
      engineHint: 'Choose the engine for new sessions', engineShort: 'Engine',
      engineDeepseek: 'DeepSeek', engineCodex: 'Codex', engineClaude: 'Claude',
      engineSwitchTitle: 'Current session engine is fixed',
      engineSwitchHint: 'This change applies only to new sessions.',
      engineSwitchDismiss: 'Dismiss engine switch notice',
    }[key] ?? key)
    const setDefaultEngine = vi.fn().mockResolvedValue({ ok: true as const })
    render(<EngineAction
      catalog={vi.fn().mockResolvedValue({ ok: true as const, value: { defaultEngine: 'deepseek', engines: [{ id: 'deepseek', availability: 'available' }, { id: 'codex', availability: 'available' }, { id: 'claude', availability: 'available' }] } })}
      setDefaultEngine={setDefaultEngine}
      sessionId="blank-session"
      useSession={selector => selector({ blank: true })}
      t={t as never}
    />)

    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'claude' } })
    await waitFor(() => { expect(setDefaultEngine).toHaveBeenCalledWith('claude') })
    expect(screen.queryByText('Current session engine is fixed')).toBeNull()
  })

})
