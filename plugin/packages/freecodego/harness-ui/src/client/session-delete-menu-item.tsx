/**
 * The session row menu's destructive entry: delete this conversation.
 *
 * This row is the plugin's only control for the action. A trash button used to
 * float over whichever session row the pointer was on, and this row replaced it:
 * same action, named, reachable without hovering, and placed after Archive
 * (`order` 500, where the shipped rows step by 100).
 *
 * Two of its rules cannot be stated from inside a menu:
 *
 * - **The failure is reported elsewhere.** Selecting this row dismisses the menu
 *   it lives in, so the row that would say "it failed" is gone before the Host
 *   answers. The refusal is published as an event instead, and
 *   {@link ./session-delete-notice} — registered in the frame-wide layer, which
 *   outlives any menu — draws it.
 * - **The capability gate is the same switch.** `sessionDeleteEnabled` decides
 *   whether the control exists at all; the row hides itself instead of offering
 *   an action the Host will refuse.
 *
 * Which row may be deleted is the Host's rule, not this row's choice: the session
 * on screen is not one of them, because the Host refuses to delete the session it
 * is holding open. A named row that stayed visible would offer an action that
 * always fails, so this one is absent for that session too.
 *
 * @module client/session-delete-menu-item
 */

import { useEffect, useState, type ReactNode } from 'react'
import { IconTrashOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import { CAPABILITY_CHANGE_EVENT } from './settings-tab.tsx'

/**
 * Carries one failed deletion from the menu row to the overlay that reports it.
 *
 * `detail` is the Host's own message: it is the only copy that can name the
 * refusal (`SESSION_DELETE_REQUIRES_CLOSED_SESSION`, and so on), and the notice
 * that draws it appends its localized lead-in around it.
 */
export const SESSION_DELETE_FAILED_EVENT = 'freecodego:session-delete-failed'

/** The menu's open-state pair, bound by the row owner through the injected hook. */
export type UseMenuOpenState = () => readonly [open: boolean, setOpen: (open: boolean) => void]

/** What the menu row renders from: the row's identity, its share, and the locale seat. */
export interface SessionDeleteMenuItemProps {
  /** Session the row shows. */
  readonly sessionId: string
  /** Menu open state: selecting the row dismisses the menu it lives in. */
  readonly useMenuOpenState: UseMenuOpenState
  /** Delete one conversation through the Host. */
  readonly deleteSession: (sessionId: string) => Promise<void>
  /** The delete capability switch; absent reads as enabled, like every other caller. */
  readonly isEnabled?: () => Promise<boolean>
  /** The session on screen, when the client exposes one; that row cannot be deleted. */
  readonly currentSessionId?: () => string | undefined
  /** Localized label reader for this plugin's namespace. */
  readonly t: (key: 'sessionDelete') => string
}

/**
 * Publish one failed deletion to whichever surface reports it.
 *
 * Dispatched on `globalThis` rather than passed down: the notice is a sibling
 * registration in another slot and has no prop path from here.
 * @param message - the Host's refusal text.
 */
export function reportSessionDeleteFailure(message: string): void {
  globalThis.dispatchEvent(new CustomEvent(SESSION_DELETE_FAILED_EVENT, { detail: message }))
}

/**
 * Render the destructive menu row, or nothing while the capability is off.
 * @param props - the row identity, the delete share, and the locale seat.
 * @returns the menu row, or null.
 */
export function SessionDeleteMenuItem({
  sessionId, useMenuOpenState, deleteSession, isEnabled, currentSessionId, t,
}: SessionDeleteMenuItemProps): ReactNode {
  // Read at render, not in an effect: a menu is drawn on demand, so the answer is
  // the one in force when the row was opened. A session opened underneath a menu
  // that is already open is refused by the Host and reported by the overlay.
  const open = currentSessionId?.()
  const [, setMenuOpen] = useMenuOpenState()
  const [enabled, setEnabled] = useState(true)
  // The capability RPC is read once per mount and then kept honest by the
  // settings page's own change event: the page toggles the switch in the same
  // document, so a row that only read once would keep offering a control the
  // Host now refuses.
  useEffect(() => {
    if (isEnabled === undefined) return
    let active = true
    void isEnabled().then((value) => { if (active) setEnabled(value) }, () => undefined)
    return () => { active = false }
  }, [isEnabled])
  useEffect(() => {
    const changed = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return
      const snapshot = event.detail as { readonly sessionDeleteEnabled?: boolean }
      setEnabled(snapshot.sessionDeleteEnabled !== false)
    }
    globalThis.addEventListener(CAPABILITY_CHANGE_EVENT, changed)
    return () => { globalThis.removeEventListener(CAPABILITY_CHANGE_EVENT, changed) }
  }, [])

  if (!enabled || (open !== undefined && open === sessionId)) return null
  return (
    <MenuItemButton
      danger
      icon={<IconTrashOutlineRegular size={14} />}
      onSelect={() => {
        // Dismiss first: the menu's rows unmount with it, and the failure has to
        // be reported by something that is still on screen.
        setMenuOpen(false)
        void deleteSession(sessionId).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          console.error('FreeCodeGo session deletion failed:', error)
          reportSessionDeleteFailure(message)
        })
      }}
    >
      {t('sessionDelete')}
    </MenuItemButton>
  )
}
