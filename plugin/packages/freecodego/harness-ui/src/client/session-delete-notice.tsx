/**
 * The surface that reports a session deletion the Host refused.
 *
 * Deleting a conversation is offered in the session row's "..." menu (see
 * {@link ./session-delete-menu-item}), and selecting that row dismisses the menu
 * it lives in — so the row that would have reported the refusal is unmounted by
 * the time the Host answers. This notice is registered in the frame-wide overlay
 * layer, which outlives any menu, and draws the failure the menu published
 * there: the menu does the work, this stays on screen to say how it went.
 *
 * The registration used to carry a delete control of its own — a trash button
 * floated over whichever session row the pointer was on — with the reasoning
 * that the action should not require opening a menu. That reasoning stopped
 * holding once the menu grew the same row: two controls for one deletion can
 * disagree about which row is deletable (the open session is not one of them),
 * and the floating one paid for its position by tracking every row through
 * pointer events, a MutationObserver and four tiers of identity resolution.
 * What is left here is the half the menu cannot do for itself.
 *
 * @module client/session-delete-notice
 */

import { useEffect, useState, type ReactNode } from 'react'
import { SESSION_DELETE_FAILED_EVENT } from './session-delete-menu-item.tsx'
import css from './toolbar-actions.module.css'

/**
 * Draw the newest refused deletion, or nothing while none has been refused.
 *
 * The banner is dismissable rather than timed: it is the only report a failed
 * delete gets, and a reader who looked away should still be able to read it.
 * @param props - the active locale, read the same way as this plugin's other surfaces.
 * @returns the dismissal banner, or null.
 */
export function SessionDeleteNotice({ language }: { readonly language: 'zh' | 'en' }): ReactNode {
  const [error, setError] = useState<string | undefined>()
  useEffect(() => {
    const failed = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return
      setError(String(event.detail))
    }
    globalThis.addEventListener(SESSION_DELETE_FAILED_EVENT, failed)
    return () => { globalThis.removeEventListener(SESSION_DELETE_FAILED_EVENT, failed) }
  }, [])

  const zh = language === 'zh'
  if (error === undefined) return null
  return (
    <div className={css.sessionDeleteError} role="alert">
      <span>{zh ? `删除对话失败：${error}` : `Session deletion failed: ${error}`}</span>
      <button type="button" onClick={() => { setError(undefined) }} aria-label={zh ? '关闭删除失败提示' : 'Dismiss deletion failure'}>×</button>
    </div>
  )
}
