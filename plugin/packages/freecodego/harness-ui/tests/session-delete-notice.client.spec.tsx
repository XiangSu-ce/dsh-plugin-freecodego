// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SESSION_DELETE_FAILED_EVENT } from '../src/client/session-delete-menu-item.tsx'
import { SessionDeleteNotice } from '../src/client/session-delete-notice.tsx'

/** Publish one refusal the way the menu row does, after it has dismissed itself. */
const refuseDeletion = (message: string): void => {
  globalThis.dispatchEvent(new CustomEvent(SESSION_DELETE_FAILED_EVENT, { detail: message }))
}

afterEach(() => {
  cleanup()
})

describe('SessionDeleteNotice', () => {
  it('stays invisible until something is refused', () => {
    // The registration lives in the frame-wide overlay layer, so it is mounted
    // for the whole session: silence has to be the default, not a lucky layout.
    render(<SessionDeleteNotice language="zh" />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports a failure the row menu published after dismissing itself', async () => {
    // The menu has no surface left once it closes, so its refusals arrive here.
    // Both lifetimes therefore end in one message, which is the only reason the
    // menu row can delete at all.
    render(<SessionDeleteNotice language="zh" />)

    refuseDeletion('SESSION_DELETE_REQUIRES_CLOSED_SESSION: close or switch away from this conversation before deleting it')
    const banner = await screen.findByRole('alert')
    expect(banner.textContent).toContain('删除对话失败：')
    expect(banner.textContent).toContain('SESSION_DELETE_REQUIRES_CLOSED_SESSION')
  })

  it('carries the Host wording in the locale it was handed', async () => {
    // The Host's own message is the only copy that can name the refusal, so the
    // banner wraps it rather than replacing it — in the active language.
    render(<SessionDeleteNotice language="en" />)
    refuseDeletion('network unavailable')
    const banner = await screen.findByRole('alert')
    expect(banner.textContent).toContain('Session deletion failed: network unavailable')
  })

  it('lets the reader dismiss the report it drew', async () => {
    render(<SessionDeleteNotice language="zh" />)
    refuseDeletion('SESSION_DELETE_REQUIRES_CLOSED_SESSION')

    fireEvent.click(await screen.findByRole('button', { name: '关闭删除失败提示' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the newest refusal when a second one follows a dismissed first', async () => {
    render(<SessionDeleteNotice language="zh" />)
    refuseDeletion('first refusal')
    fireEvent.click(await screen.findByRole('button', { name: '关闭删除失败提示' }))

    refuseDeletion('second refusal')
    const banner = await screen.findByRole('alert')
    expect(banner.textContent).toContain('second refusal')
    expect(banner.textContent).not.toContain('first refusal')
  })
})
