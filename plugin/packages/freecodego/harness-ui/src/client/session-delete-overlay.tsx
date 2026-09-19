import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './toolbar-actions.module.css'

type Position = { readonly top: number; readonly left: number }
type SessionListSnapshot = {
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, {
    readonly id: string
    readonly displayTitle: string
    /** Local ownership counts; the session the main view retains is on screen. */
    readonly retainedBy: Readonly<Partial<Record<string, number>>>
  }>>
}
type UseSessions = <T>(selector: (snapshot: SessionListSnapshot) => T) => T
type DeleteAction = {
  readonly session: { readonly id: string; readonly displayTitle: string }
  readonly position: Position
  /** The Host refuses to delete the session that is currently open. */
  readonly current?: boolean
}

const zhLike = (): boolean => !(document.documentElement.lang?.toLowerCase().startsWith('en') ?? false)

/** Direct-delete controls rendered over all visible session rows. */
export function SessionDeleteOverlay({ useSessions, deleteSession, capabilities, isEnabled }: {
  readonly useSessions: UseSessions
  readonly deleteSession: (sessionId: string) => Promise<void>
  readonly capabilities?: () => Promise<RemoteResult<{ readonly sessionDeleteEnabled?: boolean }>>
  readonly isEnabled?: () => Promise<boolean>
}): ReactNode {
  const sessions = useSessions(snapshot => snapshot)
  const [enabled, setEnabled] = useState(true)
  const [actions, setActions] = useState<readonly DeleteAction[]>([])
  const [deleting, setDeleting] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const hoveredRow = useRef<HTMLElement | undefined>()
  const hideTimer = useRef<number | undefined>()
  // Slot injectors re-create these closures on every render; keying the effect
  // on their identity would refire the settings RPC on every parent update.
  const capabilityCall = useRef({ isEnabled, capabilities })
  useEffect(() => { capabilityCall.current = { isEnabled, capabilities } })
  useEffect(() => {
    let active = true
    const refresh = (): void => {
      const { isEnabled, capabilities } = capabilityCall.current
      if (isEnabled !== undefined) { void isEnabled().then((value) => { if (active) setEnabled(value) }, () => undefined); return }
      if (capabilities !== undefined) void capabilities().then((result) => { if (active && result.ok) setEnabled(result.value.sessionDeleteEnabled !== false) }, () => undefined)
    }
    const changed = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return
      const snapshot = event.detail as { readonly sessionDeleteEnabled?: boolean }
      setEnabled(snapshot.sessionDeleteEnabled !== false)
    }
    refresh()
    globalThis.addEventListener('freecodego:capability-change', changed)
    return () => { active = false; globalThis.removeEventListener('freecodego:capability-change', changed) }
  }, [])
  const overlayRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let frame: number | undefined
    const update = (): void => {
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const row = hoveredRow.current
        const session = row === undefined ? undefined : resolveSession(row, sessions)
        const rect = row?.getBoundingClientRect()
        // The open session cannot be deleted until another session is opened,
        // so its row never shows the control in the first place.
        const current = session !== undefined && currentSessionId(sessions) === session.id
        const next = session === undefined || current || rect === undefined || rect.width <= 0 || rect.height <= 0
          ? []
          : [{ session, position: { top: rect.top + (rect.height - 20) / 2, left: rect.right - 60 }, current: false }]
        setActions(previous => sameActions(previous, next) ? previous : next)
      })
    }
    const clearHide = (): void => {
      if (hideTimer.current !== undefined) window.clearTimeout(hideTimer.current)
      hideTimer.current = undefined
    }
    const hide = (): void => {
      clearHide()
      hideTimer.current = window.setTimeout(() => {
        hoveredRow.current = undefined
        update()
      }, 120)
    }
    const hoveredSessionRow = (target: EventTarget | null): HTMLElement | undefined => {
      if (!(target instanceof Element)) return undefined
      const row = target.closest<HTMLElement>('[role="treeitem"][aria-selected]')
      return row === null ? undefined : row
    }
    const onPointerOver = (event: PointerEvent): void => {
      const row = hoveredSessionRow(event.target)
      if (row === undefined) return
      clearHide()
      if (hoveredRow.current === row) return
      hoveredRow.current = row
      update()
    }
    const onPointerOut = (event: PointerEvent): void => {
      const row = hoveredSessionRow(event.target)
      if (row === undefined || row.contains(event.relatedTarget as Node | null) || overlayRef.current?.contains(event.relatedTarget as Node | null)) return
      hide()
    }
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-selected'] })
    window.addEventListener('resize', update)
    document.addEventListener('scroll', update, true)
    document.addEventListener('pointerover', onPointerOver)
    document.addEventListener('pointerout', onPointerOut)
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      clearHide()
      observer.disconnect()
      window.removeEventListener('resize', update)
      document.removeEventListener('scroll', update, true)
      document.removeEventListener('pointerover', onPointerOver)
      document.removeEventListener('pointerout', onPointerOut)
    }
  }, [sessions])

  const remove = (sessionId: string): void => {
    if (deleting !== undefined) return
    setDeleting(sessionId)
    // Clear the previous failure so a retry shows only the newest outcome.
    setError(undefined)
    void deleteSession(sessionId).catch((error: unknown) => {
      console.error('FreeCodeGo session deletion failed:', error)
      setError(error instanceof Error ? error.message : String(error))
    }).finally(() => { setDeleting(undefined) })
  }

  if (!enabled) return null
  return <>{error === undefined ? null : (
    <div className={css.sessionDeleteError} role="alert">
      <span>{zhLike() ? `删除对话失败：${error}` : `Session deletion failed: ${error}`}</span>
      <button type="button" onClick={() => { setError(undefined) }} aria-label={zhLike() ? '关闭删除失败提示' : 'Dismiss deletion failure'}>×</button>
    </div>
  )}{actions.filter(({ current }) => !current).map(({ session, position }) => (
    <div ref={overlayRef} key={session.id} className={css.sessionDeleteOverlay} style={position} onPointerDown={(event) => { event.stopPropagation() }} onMouseDown={(event) => { event.stopPropagation() }} onPointerEnter={() => { if (hideTimer.current !== undefined) window.clearTimeout(hideTimer.current) }}>
      <button
        className={`${css.sessionDelete} ${css.action}`}
        type="button"
        aria-label={`${zhLike() ? '删除对话' : 'Delete session'} ${session.displayTitle}`}
        title={zhLike() ? '删除对话' : 'Delete session'}
        disabled={deleting !== undefined}
        onPointerDown={(event) => { event.stopPropagation() }}
        onMouseDown={(event) => { event.stopPropagation() }}
        onClick={(event) => { event.stopPropagation(); remove(session.id) }}
      ><IconTrashOutline16 size={16} /></button>
    </div>
  ))}</>
}

/**
 * The session the shell is currently showing.
 *
 * alpha.2 removed `SessionListState.current`, so "which session is open" is read
 * as ownership now: the session the main view retains is the one on screen. Same
 * derivation as upstream's own `ui-layout/DocumentTitle` — and the same one
 * `companion/companion.tsx` makes for the rail mark, which has to agree with this
 * overlay about which row is the open one.
 * @param sessions - the Session Controller list snapshot.
 * @returns the visible session id, or undefined while nothing is open.
 */
function currentSessionId(sessions: SessionListSnapshot): string | undefined {
  return Object.values(sessions.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
}

/**
 * Which session a hovered row belongs to, resolved through four tiers.
 *
 * 1. `data-session-id` — the row's own public identity attribute. Core rows
 *    publish it, so this is the only tier that reads a declared fact rather
 *    than inferring one, and it resolves duplicate titles without help.
 * 2. The selected row is the open session.
 * 3. React's host fiber, for a host that predates the attribute.
 * 4. A unique title prefix, for a host that has neither.
 *
 * The lower tiers are compatibility, not design: they exist so an older host
 * still renders the control. None of them can delete the wrong session — a
 * tier that cannot prove its answer returns `undefined` and the control simply
 * does not appear.
 */
function resolveSession(
  row: HTMLElement,
  sessions: SessionListSnapshot,
): { readonly id: string; readonly displayTitle: string } | undefined {
  const declared = row.dataset.sessionId
  if (declared !== undefined && sessions.byId[declared] !== undefined) return sessions.byId[declared]
  const current = currentSessionId(sessions)
  if (row.getAttribute('aria-selected') === 'true' && current !== undefined) {
    return sessions.byId[current]
  }
  const fromFiber = sessionFromReactFiber(row, sessions)
  if (fromFiber !== undefined) return fromFiber
  const text = row.textContent?.trim() ?? ''
  const matches = sessions.ids.filter((id) => {
    const title = sessions.byId[id]?.displayTitle
    return title !== undefined && title !== '' && text.startsWith(title)
  })
  return matches.length === 1 ? sessions.byId[matches[0]!] : undefined
}

/** Compatibility tier for a host whose rows carry no `data-session-id`. */
function sessionFromReactFiber(row: HTMLElement, sessions: SessionListSnapshot): { readonly id: string; readonly displayTitle: string } | undefined {
  const host = row as unknown as Record<string, unknown>
  for (const key of Object.getOwnPropertyNames(host)) {
    if (!key.startsWith('__reactFiber$')) continue
    let fiber = host[key] as { readonly memoizedProps?: unknown; readonly return?: unknown } | undefined
    while (fiber !== undefined) {
      const props = fiber.memoizedProps as { readonly node?: { readonly id?: unknown } } | undefined
      const id = typeof props?.node?.id === 'string' ? props.node.id : undefined
      if (id !== undefined && sessions.byId[id] !== undefined) return sessions.byId[id]
      fiber = fiber.return as typeof fiber
    }
  }
  return undefined
}

function sameActions(left: readonly DeleteAction[], right: readonly DeleteAction[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const candidate = right[index]
    return candidate !== undefined
      && entry.session.id === candidate.session.id
      && entry.position.top === candidate.position.top
      && entry.position.left === candidate.position.left
  })
}
