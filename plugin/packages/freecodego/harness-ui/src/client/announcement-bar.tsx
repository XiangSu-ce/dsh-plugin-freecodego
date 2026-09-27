/**
 * The backend's announcements, on the client's own surface.
 *
 * One channel: the top bar. Every announcement the backend returns rides it, and
 * the notify mode is the only emphasis signal the announcement schema carries —
 * there is no colour or priority field — so it decides the tone instead (green
 * for a quiet 静默 notice, red for a 弹窗 one). The plugin deliberately opens no
 * dialog of its own: a notice nobody asked for must not take the screen, and the
 * full text is a click away, here and in the settings section.
 *
 * The bar shows one announcement at a time — the newest — and offers the rest
 * behind a count, because a stripe that cycles through everything at once is a
 * stripe nobody reads.
 *
 * Closing a notice is the account's record, not this browser's: the click calls
 * the backend's mark-read route through the Host, so the same announcement stays
 * closed on the account's other machines and the administrator's read report
 * counts it. The client keeps its own dismissal list as a fallback (see
 * {@link ./announcement-preference}) so a failed round trip cannot resurrect a
 * notice the user already closed.
 *
 * The settings section renders the same feed as a list, which is also how a user
 * who hid the bar gets it back — a switch that lives only on the surface it
 * hides would be a one-way door.
 *
 * @module client/announcement-bar
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { MarkdownText, Modal, extractMarkdownPlainText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  dismissAnnouncement,
  pruneAnnouncements,
  readAnnouncementPreference,
  setAnnouncementBarVisible,
  subscribeAnnouncementPreference,
} from './announcement-preference.ts'
import type { AnnouncementPreference } from './announcement-preference.ts'
import css from './announcement-bar.module.css'

/**
 * How often the bar asks the backend for notices.
 *
 * The plugin has no push channel — announcements are a plain authenticated GET —
 * so "in time" is this poll. Long enough that the request is invisible in a
 * normal session, short enough that a 福利 posted while someone works is seen
 * without a reload.
 */
const POLL_MS = 120_000

/** One announcement as the Host projects it. Structural copy of the Host type: the browser bundle cannot import the Host's. */
export interface Announcement {
  readonly id: number
  readonly title: string
  readonly content: string
  readonly notifyMode: 'silent' | 'popup'
  readonly readAt?: string
  readonly createdAt: string
}

/** What the surfaces are allowed to do, supplied by the client entry point. */
export interface AnnouncementFeedProps {
  /** Read the announcements this account may see. Empty means nothing to show. */
  readonly list: () => Promise<readonly Announcement[]>
  /** Mark one announcement read for the account; `false` when the backend could not be reached. */
  readonly markRead: (announcementId: number) => Promise<boolean>
  readonly language: 'zh' | 'en'
}

const zh = {
  barLabel: '公告',
  bonus: '福利',
  urgent: '重要',
  details: '详情',
  more: (count: number) => `还有 ${count} 条`,
  close: (title: string) => `关闭公告「${title}」`,
  dismiss: '关闭',
  gotIt: '知道了',
  listTitle: '公告',
  listDetail: '关闭即标记为已读，账号在其它设备上也不会再提示。',
  markRead: '标记已读',
  read: '已读',
  unread: '未读',
  showBar: '显示顶部公告栏',
  showBarHint: '公告会在对话页顶部滚动显示。',
  settingsTitle: '公告',
  settingsDetail: '后端发布的通知。关闭后账号在其它设备上也不会再提示，仍可在此重新查看。',
  empty: '当前没有公告。',
  closeDialog: '关闭',
  codeCopy: '复制',
  codeCopied: '已复制',
  footnotes: '脚注',
} as const

const en = {
  barLabel: 'Announcement',
  bonus: 'Update',
  urgent: 'Important',
  details: 'Details',
  more: (count: number) => `${count} more`,
  close: (title: string) => `Close announcement “${title}”`,
  dismiss: 'Close',
  gotIt: 'Got it',
  listTitle: 'Announcements',
  listDetail: 'Closing one marks it read, so the account stops showing it on your other devices.',
  markRead: 'Mark read',
  read: 'Read',
  unread: 'Unread',
  showBar: 'Show the top announcement bar',
  showBarHint: 'Announcements scroll along the top of the conversation.',
  settingsTitle: 'Announcements',
  settingsDetail: 'Notices published by the backend. Closing one marks it read for the account; it stays listed here.',
  empty: 'There are no announcements right now.',
  closeDialog: 'Close',
  codeCopy: 'Copy',
  codeCopied: 'Copied',
  footnotes: 'Footnotes',
} as const

/**
 * The live feed both surfaces render.
 *
 * One poll, one dismissal path, one preference reader: the bar and the settings
 * list are two views of the same account data, and a second copy of either would
 * be the place they disagree.
 * @param props - the backend calls and the locale to render in.
 * @returns the announcements, the client preference, and the two mutators.
 */
function useAnnouncementFeed({ list, markRead, language }: AnnouncementFeedProps) {
  const text = language === 'zh' ? zh : en
  const [items, setItems] = useState<readonly Announcement[]>([])
  const [preference, setPreference] = useState<AnnouncementPreference>(readAnnouncementPreference)

  useEffect(() => subscribeAnnouncementPreference(() => { setPreference(readAnnouncementPreference()) }), [])

  const poll = useCallback(async (): Promise<void> => {
    let fetched: readonly Announcement[]
    try {
      fetched = await list()
    } catch {
      // The Host answers an empty list for a signed-out or unreachable backend;
      // a throw here is this client's own failure, and the notice surfaces are
      // not where it should be reported.
      return
    }
    // Newest first: the bar shows one notice at a time, and the newest is the
    // one nobody has read yet in the ordinary case.
    const ordered = [...fetched].sort((left, right) => right.id - left.id)
    setItems(ordered)
    pruneAnnouncements(ordered.map(item => item.id))
    setPreference(readAnnouncementPreference())
  }, [list])

  useEffect(() => {
    void poll()
    const timer = globalThis.setInterval(() => { void poll() }, POLL_MS)
    // A machine that was asleep, or a tab that was closed, asks again on return
    // rather than waiting out the interval.
    const onVisible = (): void => { if (document.visibilityState === 'visible') void poll() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      globalThis.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [poll])

  const close = useCallback((announcement: Announcement): void => {
    // Locally first: the gesture is answered by the notice leaving, and the
    // acknowledgement below is what makes it hold on the account's other machines.
    dismissAnnouncement(announcement.id)
    setPreference(readAnnouncementPreference())
    setItems(current => current.map(item => item.id === announcement.id ? { ...item, readAt: new Date().toISOString() } : item))
    void markRead(announcement.id).catch(() => false)
  }, [markRead])

  const setBar = useCallback((visible: boolean): void => {
    setAnnouncementBarVisible(visible)
    setPreference(readAnnouncementPreference())
  }, [])

  const unread = useMemo(
    () => items.filter(item => item.readAt === undefined && !preference.dismissed.includes(item.id)),
    [items, preference.dismissed],
  )

  return { text, items, unread, preference, close, setBar, poll }
}

/** The Markdown chrome a rendered announcement needs; the plugin supplies its own copy. */
function useMarkdownLabels(text: { readonly codeCopy: string; readonly codeCopied: string; readonly footnotes: string }): MarkdownLabels {
  return useMemo(
    () => ({ code: { copyLabel: text.codeCopy, copiedLabel: text.codeCopied }, footnotes: text.footnotes }),
    [text],
  )
}

/** One line for the moving bar: the title, then as much of the body as fits without markup. */
function marqueeOf(announcement: Announcement): string {
  const body = extractMarkdownPlainText(announcement.content, { mode: 'all' }).replace(/\s+/gu, ' ').trim()
  return body === '' ? announcement.title : `${announcement.title}：${body}`
}

/**
 * The announcement bar.
 *
 * Rendered from a root-level shell slot, so one instance owns the whole app: an
 * announcement is not tied to a session, and a second registration would show
 * the same notice twice.
 * @param props - the backend calls and the locale to render in.
 * @returns the bar, the dialogs a click opens, or null while there is nothing to show.
 */
export function AnnouncementBar(props: AnnouncementFeedProps) {
  const { text, items, unread, preference, close, setBar } = useAnnouncementFeed(props)
  const [panel, setPanel] = useState<{ readonly kind: 'detail'; readonly id: number } | { readonly kind: 'list' } | undefined>()
  const labels = useMarkdownLabels(text)

  const current = unread[0]
  const detail = panel?.kind === 'detail' ? items.find(item => item.id === panel.id) : undefined
  /** The close path the bar and both dialogs share: leaving a notice on screen after the user acknowledged it is the one thing a close button must not do. */
  const dismiss = useCallback((announcement: Announcement): void => {
    close(announcement)
    setPanel(currentPanel => currentPanel !== undefined && currentPanel.kind === 'detail' && currentPanel.id === announcement.id ? undefined : currentPanel)
  }, [close])

  return <>
    {current !== undefined && preference.bar
      ? <div className={`${css.bar} ${current.notifyMode === 'popup' ? css.urgent : css.bonus}`} role="status" aria-label={text.barLabel}>
        <span className={css.badge}>{current.notifyMode === 'popup' ? text.urgent : text.bonus}</span>
        <span className={css.track}>
          <button
            className={css.marquee}
            type="button"
            title={text.details}
            // Duration tracks the text so a long announcement does not fly past:
            // a reader needs roughly the same seconds-per-character either way.
            style={{ animationDuration: `${Math.min(60, Math.max(14, Math.round(marqueeOf(current).length * 0.4)))}s` }}
            onClick={() => { setPanel({ kind: 'detail', id: current.id }) }}
          >
            {marqueeOf(current)}
          </button>
        </span>
        {unread.length > 1
          ? <button className={css.action} type="button" onClick={() => { setPanel({ kind: 'list' }) }}>{text.more(unread.length - 1)}</button>
          : null}
        <button className={css.action} type="button" aria-label={text.close(current.title)} onClick={() => { dismiss(current) }}>{text.dismiss}</button>
      </div>
      : null}

    <Modal
      open={detail !== undefined}
      onClose={() => { setPanel(undefined) }}
      title={detail?.title ?? ''}
      closeLabel={text.closeDialog}
      footer={detail === undefined ? undefined : <>
        <label className={css.switch}><input type="checkbox" checked={preference.bar} onChange={(event) => { setBar(event.target.checked) }} />{text.showBar}</label>
        <div className={css.footerButtons}>
          <button className={css.primary} type="button" onClick={() => { if (detail !== undefined) dismiss(detail) }}>{text.gotIt}</button>
        </div>
      </>}
    >
      {detail === undefined ? null : <div className={css.document}>
        <MarkdownText text={detail.content} labels={labels} variant="compact" />
      </div>}
    </Modal>

    <Modal
      open={panel?.kind === 'list'}
      onClose={() => { setPanel(undefined) }}
      title={text.listTitle}
      closeLabel={text.closeDialog}
      description={text.listDetail}
      footer={<label className={css.switch}><input type="checkbox" checked={preference.bar} onChange={(event) => { setBar(event.target.checked) }} />{text.showBar}</label>}
    >
      <AnnouncementRows items={items} text={text} onOpen={(id) => { setPanel({ kind: 'detail', id }) }} onMarkRead={(announcement) => { dismiss(announcement) }} />
    </Modal>
  </>
}

/** The words the row list itself needs, out of either dictionary. */
interface AnnouncementRowText {
  readonly bonus: string
  readonly urgent: string
  readonly more: (count: number) => string
  readonly markRead: string
  readonly read: string
  readonly unread: string
  readonly empty: string
}

/** The list body both the bar's dialog and the settings section render. */
function AnnouncementRows({ items, text, onOpen, onMarkRead }: {
  readonly items: readonly Announcement[]
  readonly text: AnnouncementRowText
  readonly onOpen: (id: number) => void
  readonly onMarkRead: (announcement: Announcement) => void
}) {
  if (items.length === 0) return <p className={css.empty}>{text.empty}</p>
  return <ul className={css.rows}>
    {items.map(item => <li className={css.row} key={item.id}>
      <button className={css.rowTitle} type="button" onClick={() => { onOpen(item.id) }}>
        <span className={`${css.dot} ${item.notifyMode === 'popup' ? css.dotUrgent : css.dotBonus}`} aria-hidden="true" />
        {item.title}
      </button>
      <span className={css.rowState}>{item.readAt === undefined ? text.unread : text.read}</span>
      {item.readAt === undefined
        ? <button className={css.action} type="button" onClick={() => { onMarkRead(item) }}>{text.markRead}</button>
        : null}
    </li>)}
  </ul>
}

/**
 * The settings section: the announcement history, and the switch that brings the
 * bar back.
 *
 * This is the other half of "hide the bar" — the bar's own switch disappears with
 * the bar, so a section that lists the same feed is what keeps a hidden notice
 * reachable rather than lost.
 * @param props - the backend calls and the locale to render in.
 * @returns the section's rows and its switch.
 */
export function AnnouncementSettingsSection(props: AnnouncementFeedProps) {
  const { text, items, preference, close, setBar } = useAnnouncementFeed(props)
  const [openId, setOpenId] = useState<number | undefined>()
  const labels = useMarkdownLabels(text)
  const detail = openId === undefined ? undefined : items.find(item => item.id === openId)

  return <section className={css.section}>
    <label className={css.switch}><input type="checkbox" checked={preference.bar} onChange={(event) => { setBar(event.target.checked) }} />{text.showBar}</label>
    <small className={css.sectionHint}>{text.showBarHint}</small>
    <p className={css.sectionHint}>{text.settingsDetail}</p>
    <AnnouncementRows
      items={items}
      text={text}
      onOpen={(id) => { setOpenId(id) }}
      onMarkRead={(announcement) => { close(announcement) }}
    />
    <Modal
      open={detail !== undefined}
      onClose={() => { setOpenId(undefined) }}
      title={detail?.title ?? ''}
      closeLabel={text.closeDialog}
      footer={detail === undefined ? undefined : <div className={css.footerButtons}>
        <button className={css.primary} type="button" onClick={() => { close(detail); setOpenId(undefined) }}>
          {detail.readAt === undefined ? text.gotIt : text.closeDialog}
        </button>
      </div>}
    >
      {detail === undefined ? null : <div className={css.document}>
        <MarkdownText text={detail.content} labels={labels} variant="compact" />
      </div>}
    </Modal>
  </section>
}
