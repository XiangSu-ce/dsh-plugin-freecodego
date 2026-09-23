// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_DELETE_FAILED_EVENT } from '../src/client/session-delete-menu-item.tsx'
import { SessionDeleteOverlay } from '../src/client/session-delete-overlay.tsx'

let row: HTMLElement

beforeEach(() => {
  row = document.createElement('div')
  row.setAttribute('role', 'treeitem')
  row.setAttribute('aria-selected', 'false')
  row.textContent = '未分组会话 3天'
  vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 100, right: 350, bottom: 140, width: 350, height: 40 } as DOMRect)
  document.body.append(row)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
})

afterEach(() => {
  cleanup()
  row.remove()
  globalThis.localStorage.clear()
  vi.unstubAllGlobals()
})

/**
 * A Session list snapshot with one row marked as the one on screen.
 *
 * `retainedBy.mainView` is how alpha.2 says "this session is open": the
 * `SessionListState.current` field the overlay used to read is gone. A row
 * without the count stands in for a session nothing is showing — the state these
 * fixtures used to express as `current: undefined`.
 * @param rows - the sessions the host lists.
 * @param currentId - the session the main view retains, when there is one.
 * @returns the snapshot the overlay reads.
 */
function sessionsSnapshot(
  rows: readonly { readonly id: string; readonly displayTitle: string }[],
  currentId?: string,
): {
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, {
    readonly id: string
    readonly displayTitle: string
    readonly retainedBy: Readonly<Partial<Record<string, number>>>
  }>>
} {
  return {
    ids: rows.map(row => row.id),
    byId: Object.fromEntries(rows.map(row => [row.id, {
      ...row,
      retainedBy: row.id === currentId ? { mainView: 1 } : {},
    }])),
  }
}

type SessionsSnapshot = ReturnType<typeof sessionsSnapshot>

describe('SessionDeleteOverlay', () => {
  it('deletes an ungrouped session directly without rendering a dialog', async () => {
    const useSessions = <T,>(selector: (snapshot: SessionsSnapshot) => T): T =>
      selector(sessionsSnapshot([{ id: 'session-1', displayTitle: '未分组会话' }]))
    const deleteSession = vi.fn().mockResolvedValue(undefined)
    render(<SessionDeleteOverlay useSessions={useSessions} deleteSession={deleteSession} />)

    expect(screen.queryByRole('button', { name: '删除对话 未分组会话' })).toBeNull()
    fireEvent.pointerOver(row)
    const button = await screen.findByRole('button', { name: '删除对话 未分组会话' })
    await waitFor(() => { expect(button.parentElement?.style.left).toBe('290px') })
    expect(button.parentElement?.style.top).toBe('110px')
    fireEvent.click(button)
    await waitFor(() => { expect(deleteSession).toHaveBeenCalledTimes(1) })
    expect(screen.queryByRole('dialog', { name: '删除对话' })).toBeNull()
  })

  it('resolves a hovered duplicate title by the row React fiber rather than the selected session', async () => {
    row.textContent = '你好 5分钟'
    Object.defineProperty(row, '__reactFiber$test', { value: { memoizedProps: { node: { id: 'session-2' } } } })
    const useSessions = <T,>(selector: (snapshot: SessionsSnapshot) => T): T => selector(sessionsSnapshot(
      [{ id: 'session-1', displayTitle: '你好' }, { id: 'session-2', displayTitle: '你好' }],
      'session-1',
    ))
    const deleteSession = vi.fn().mockResolvedValue(undefined)
    render(<SessionDeleteOverlay useSessions={useSessions} deleteSession={deleteSession} />)

    fireEvent.pointerOver(row)
    fireEvent.click(await screen.findByRole('button', { name: '删除对话 你好' }))
    await waitFor(() => { expect(deleteSession).toHaveBeenCalledWith('session-2') })
  })

  it('resolves a hovered duplicate title from the row attribute alone', async () => {
    row.textContent = '你好 5分钟'
    row.setAttribute('data-session-id', 'session-2')
    // Deliberately no `__reactFiber$` property: the attribute has to carry the
    // answer on its own, including for the duplicate title the fiber tier exists
    // to resolve.
    const useSessions = <T,>(selector: (snapshot: SessionsSnapshot) => T): T => selector(sessionsSnapshot(
      [{ id: 'session-1', displayTitle: '你好' }, { id: 'session-2', displayTitle: '你好' }],
      'session-1',
    ))
    const deleteSession = vi.fn().mockResolvedValue(undefined)
    render(<SessionDeleteOverlay useSessions={useSessions} deleteSession={deleteSession} />)

    fireEvent.pointerOver(row)
    fireEvent.click(await screen.findByRole('button', { name: '删除对话 你好' }))
    await waitFor(() => { expect(deleteSession).toHaveBeenCalledWith('session-2') })
  })

  it('prefers the row attribute over a fiber naming another session', async () => {
    row.textContent = '你好 5分钟'
    row.setAttribute('data-session-id', 'session-2')
    Object.defineProperty(row, '__reactFiber$test', { value: { memoizedProps: { node: { id: 'session-1' } } } })
    const useSessions = <T,>(selector: (snapshot: SessionsSnapshot) => T): T => selector(sessionsSnapshot(
      [{ id: 'session-1', displayTitle: '甲' }, { id: 'session-2', displayTitle: '乙' }],
    ))
    const deleteSession = vi.fn().mockResolvedValue(undefined)
    render(<SessionDeleteOverlay useSessions={useSessions} deleteSession={deleteSession} />)

    fireEvent.pointerOver(row)
    fireEvent.click(await screen.findByRole('button', { name: '删除对话 乙' }))
    await waitFor(() => { expect(deleteSession).toHaveBeenCalledWith('session-2') })
  })

  it('reports a failure the row menu published after dismissing itself', async () => {
    // The menu has no surface left once it closes, so its refusals arrive here.
    // Both callers therefore end in one message, which is the only reason the
    // menu row can delete at all.
    const useSessions = <T,>(selector: (snapshot: SessionsSnapshot) => T): T =>
      selector(sessionsSnapshot([{ id: 'session-1', displayTitle: '未分组会话' }]))
    render(<SessionDeleteOverlay useSessions={useSessions} deleteSession={vi.fn()} />)

    globalThis.dispatchEvent(new CustomEvent(SESSION_DELETE_FAILED_EVENT, {
      detail: 'SESSION_DELETE_REQUIRES_CLOSED_SESSION: close or switch away from this conversation before deleting it',
    }))
    const banner = await screen.findByRole('alert')
    expect(banner.textContent).toContain('删除对话失败：')
    expect(banner.textContent).toContain('SESSION_DELETE_REQUIRES_CLOSED_SESSION')
  })

  it('hides the delete control while the currently open session is hovered', async () => {
    Object.defineProperty(row, '__reactFiber$test', { value: { memoizedProps: { node: { id: 'session-1' } } } })
    const useSessions = <T,>(selector: (snapshot: SessionsSnapshot) => T): T => selector(sessionsSnapshot(
      [{ id: 'session-1', displayTitle: '当前会话' }, { id: 'session-2', displayTitle: '其他会话' }],
      'session-1',
    ))
    const deleteSession = vi.fn().mockResolvedValue(undefined)
    render(<SessionDeleteOverlay useSessions={useSessions} deleteSession={deleteSession} />)

    fireEvent.pointerOver(row)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(screen.queryByRole('button', { name: /删除对话 当前会话/ })).toBeNull()
    expect(deleteSession).not.toHaveBeenCalled()
  })

})
