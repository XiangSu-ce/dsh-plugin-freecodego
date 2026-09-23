// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SESSION_DELETE_FAILED_EVENT, SessionDeleteMenuItem } from '../src/client/session-delete-menu-item.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** The row's locale seat, as the renderer binds it. */
const t = (key: 'sessionDelete'): string => key === 'sessionDelete' ? '删除会话' : key

describe('SessionDeleteMenuItem', () => {
  it('offers the destructive row and dismisses its menu before deleting', async () => {
    const setMenuOpen = vi.fn()
    const deleteSession = vi.fn().mockResolvedValue(undefined)
    render(
      <SessionDeleteMenuItem
        sessionId="session-1"
        useMenuOpenState={() => [true, setMenuOpen]}
        deleteSession={deleteSession}
        t={t}
      />,
    )

    fireEvent.click(screen.getByRole('menuitem', { name: '删除会话' }))
    // The menu has to go first: the row that would report a failure unmounts
    // with the list, so a failure reported after dismissal needs another surface.
    expect(setMenuOpen).toHaveBeenCalledWith(false)
    await waitFor(() => { expect(deleteSession).toHaveBeenCalledWith('session-1') })
  })

  it('publishes a refusal as an event instead of dropping it with the menu', async () => {
    const failures: string[] = []
    globalThis.addEventListener(SESSION_DELETE_FAILED_EVENT, (event) => { failures.push(String((event as CustomEvent).detail)) })
    const deleteSession = vi.fn().mockRejectedValue(new Error('SESSION_DELETE_REQUIRES_CLOSED_SESSION: close or switch away'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <SessionDeleteMenuItem
        sessionId="session-2"
        useMenuOpenState={() => [true, vi.fn()]}
        deleteSession={deleteSession}
        t={t}
      />,
    )

    fireEvent.click(screen.getByRole('menuitem', { name: '删除会话' }))
    await waitFor(() => { expect(failures).toHaveLength(1) })
    expect(failures[0]).toContain('SESSION_DELETE_REQUIRES_CLOSED_SESSION')
  })

  it('steps aside for the session that is on screen, which the Host will not delete', async () => {
    const deleteSession = vi.fn().mockResolvedValue(undefined)
    const { container } = render(
      <SessionDeleteMenuItem
        sessionId="session-open"
        useMenuOpenState={() => [true, vi.fn()]}
        deleteSession={deleteSession}
        currentSessionId={() => 'session-open'}
        t={t}
      />,
    )

    // Same rule as the hover control, so the two surfaces cannot disagree about
    // which row is deletable.
    expect(container.querySelectorAll('[role="menuitem"]')).toHaveLength(0)
    expect(deleteSession).not.toHaveBeenCalled()
  })

  it('hides itself while the delete capability is switched off', async () => {
    const deleteSession = vi.fn().mockResolvedValue(undefined)
    const { container } = render(
      <SessionDeleteMenuItem
        sessionId="session-3"
        useMenuOpenState={() => [true, vi.fn()]}
        deleteSession={deleteSession}
        isEnabled={async () => false}
        t={t}
      />,
    )

    await waitFor(() => { expect(container.querySelectorAll('[role="menuitem"]')).toHaveLength(0) })
    expect(deleteSession).not.toHaveBeenCalled()
  })
})
