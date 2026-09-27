// @vitest-environment jsdom
/**
 * The announcement surfaces.
 *
 * Why these cases exist
 * --------------------
 * The bar is the plugin's only unsolicited interruption, so what is pinned here
 * is what keeps it tolerable: every announcement rides the same bar (the
 * backend's notify mode only picks the tone — green for 静默, red for 弹窗 — and
 * the plugin opens no dialog of its own), closing a notice is the *account's*
 * record rather than this browser's, and a close whose acknowledgement never
 * reached the backend must still not bring the notice back — a close button that
 * does not hold is worse than no close button.
 *
 * @module tests/announcement-bar
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnnouncementBar, AnnouncementSettingsSection, type Announcement } from '../src/client/announcement-bar.tsx'
import { dismissAnnouncement, pruneAnnouncements, readAnnouncementPreference } from '../src/client/announcement-preference.ts'

const silent: Announcement = {
  id: 11,
  title: '免费开放 gpt-5.6-terra',
  content: '本周福利：**gpt-5.6-terra** 全天免费。',
  notifyMode: 'silent',
  createdAt: '2026-09-28T00:00:00Z',
}
const urgent: Announcement = {
  id: 12,
  title: '计费维护通知',
  content: '今晚 23:00 起维护十分钟。',
  notifyMode: 'popup',
  createdAt: '2026-09-28T01:00:00Z',
}

beforeEach(() => { globalThis.localStorage.clear() })
afterEach(() => { cleanup(); globalThis.localStorage.clear() })

describe('the announcement bar', () => {
  it('rides the top bar for a quiet notice and closes it as read', async () => {
    const markRead = vi.fn(async () => true)
    render(<AnnouncementBar list={async () => [silent]} markRead={markRead} language="zh" />)

    // The badge states the channel the backend chose, and the strip carries the
    // title and the body in one moving line.
    expect(await screen.findByText('福利')).toBeTruthy()
    const marquee = await screen.findByRole('button', { name: /免费开放 gpt-5\.6-terra：本周福利/ })
    expect(marquee.textContent).toContain('本周福利：gpt-5.6-terra 全天免费。')

    fireEvent.click(screen.getByRole('button', { name: '关闭公告「免费开放 gpt-5.6-terra」' }))
    // Closing is the account's record: the click has to reach the backend…
    await waitFor(() => { expect(markRead).toHaveBeenCalledWith(11) })
    // …and the bar leaves either way, because the user's gesture was answered.
    await waitFor(() => { expect(screen.queryByText('福利')).toBeNull() })
  })

  it('rides the same bar for a popup announcement, louder but never a dialog', async () => {
    const markRead = vi.fn(async () => true)
    render(<AnnouncementBar list={async () => [urgent]} markRead={markRead} language="zh" />)

    // The tone is the interruption: the backend said 弹窗, the badge says so.
    expect(await screen.findByText('重要')).toBeTruthy()
    expect(await screen.findByRole('button', { name: /计费维护通知：今晚 23:00/ })).toBeTruthy()
    // Nothing takes the screen on its own; the notice waits on the stripe until
    // the user closes it.
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button', { name: '知道了' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '关闭公告「计费维护通知」' }))
    await waitFor(() => { expect(markRead).toHaveBeenCalledWith(12) })
    await waitFor(() => { expect(screen.queryByText('重要')).toBeNull() })
  })

  it('keeps a notice closed when the backend never recorded the read', async () => {
    // A failed round trip must not resurrect a notice the user already closed.
    const markRead = vi.fn(async () => false)
    const { unmount } = render(<AnnouncementBar list={async () => [silent]} markRead={markRead} language="zh" />)
    fireEvent.click(await screen.findByRole('button', { name: '关闭公告「免费开放 gpt-5.6-terra」' }))
    await waitFor(() => { expect(markRead).toHaveBeenCalled() })
    expect(readAnnouncementPreference().dismissed).toContain(11)

    // The next mount is the next poll: the same unread row comes back from the
    // backend, and the client's own record is what keeps it off the screen.
    unmount()
    render(<AnnouncementBar list={async () => [silent]} markRead={markRead} language="zh" />)
    await waitFor(() => { expect(screen.queryByText('福利')).toBeNull() })
  })

  it('offers the switch on the settings section, which is how a hidden bar comes back', async () => {
    render(<AnnouncementSettingsSection list={async () => [silent, urgent]} markRead={async () => true} language="zh" />)
    const toggle = await screen.findByLabelText('显示顶部公告栏') as HTMLInputElement
    expect(toggle.checked).toBe(true)
    fireEvent.click(toggle)
    await waitFor(() => { expect(readAnnouncementPreference().bar).toBe(false) })
    // The history stays reachable with the bar off: the section lists the same
    // feed, so a notice is never lost by hiding the surface that showed it.
    expect(await screen.findByText('免费开放 gpt-5.6-terra')).toBeTruthy()
    expect(await screen.findByText('计费维护通知')).toBeTruthy()
  })
})

describe('the client-side announcement record', () => {
  it('bounds and prunes the dismissals it remembers', () => {
    for (let id = 1; id <= 60; id += 1) dismissAnnouncement(id)
    const remembered = readAnnouncementPreference().dismissed
    // Bounded: the oldest are dropped, so a long-lived browser cannot grow this
    // document without limit.
    expect(remembered.length).toBe(50)
    expect(remembered).toContain(60)
    expect(remembered).not.toContain(1)

    // Pruned against what the backend still returns: an idea the backend no
    // longer has is not worth remembering.
    pruneAnnouncements([60, 59, 58])
    expect(readAnnouncementPreference().dismissed).toEqual([58, 59, 60])
  })
})
