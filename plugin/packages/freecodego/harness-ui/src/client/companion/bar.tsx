/**
 * The companion's second seat: the full-width strip above the composer.
 *
 * The rail mark can only ever be 24px — that slot hands its occupant a fixed
 * `size` in both of its seats — so it can show a pose but not the character. This
 * entry is where the character lives: `conversation.input.dock` is a **list** slot
 * rendered full width directly above the composer card, its width *is* the
 * conversation column, and upstream already docks its todo, goal, and queue strips
 * there (orders 0, 10, and 20), so "a strip that describes the agent" is an
 * established use of this seam rather than a new one.
 *
 * Three decisions are this seat's own:
 *
 * - **Size follows the column.** `ResizeObserver` on the strip's own element is
 *   the whole mechanism: the element is full width, so its measured width is the
 *   column's. No frame geometry, no private layout API, no DOM sniffing — and a
 *   column that grows shows a larger character instead of the same small dot.
 * - **The row never resizes.** Its lane is a fixed height, sized for the largest
 *   character the column policy can ask for, and it is mounted for as long as the
 *   session is. Nothing about a turn — a pose arriving, a completion playing, a
 *   resize of the panel — moves the composer stack, so the transcript above it
 *   does not jump once per turn. A row that mounted and unmounted with the work
 *   would shift the whole stack by its own height twice per turn, which is far more
 *   distracting than a quiet lane. The lane carries a resting look instead: the
 *   two quiet ends of the engine's vocabulary (`idle`, `sleep`) draw dimmed and
 *   leave the visual weight to the working poses.
 * - **The words come from the locale namespace.** A shape alone is ambiguous —
 *   three drifting dots and a drifting body are both "working" to a reader — so
 *   each pose carries its own label, and the row is a `status` region so the
 *   change is announced rather than only drawn. Staying mounted also means the
 *   region exists *before* its content changes, which is what makes an
 *   announcement reliable rather than dependent on mount timing.
 */
import { useCallback, useRef, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the SlotMap merge for `conversation.input.dock` (its owner
// share and the session standard kit) plus the global seats both share.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { CompanionSvg } from './render.tsx'
import { NS } from './companion-locale.ts'
import { useCompanionObservation, useCompanionView } from './view.ts'
import type { StateId } from './engine/states.ts'
import css from './companion.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'freecodego.companion': import('./companion-locale.ts').CompanionKey
  }
}

/**
 * Where the strip sits among the composer's dock entries.
 *
 * Upstream's own three are todo at 0, goal at 10, and queue at 20; being last puts
 * the companion closest to the input the user is about to type into, which is
 * where a status line is read.
 */
export const COMPANION_DOCK_ORDER = 30

/** Smallest edge the character is drawn at, for a narrow column. */
export const COMPANION_MIN_PX = 28

/** Largest edge, so a wide column shows a character rather than a banner. */
export const COMPANION_MAX_PX = 64

/** Share of the column the character takes. One fourteenth reads as a mark. */
const COMPANION_COLUMN_SHARE = 14

/**
 * The body colour: the surrounding text colour, resolved through the token layer
 * rather than as the engine's own `encre`, which sinks into a dark surface.
 */
const COMPANION_INK = 'var(--fcg-text-primary, currentColor)'

/**
 * The surface behind the character. It is only ever visible through the eye
 * holes, where the body paints something behind itself (an orbit, a burst) — but
 * there a wrong value is a light patch in a dark theme, so it follows the surface
 * token and keeps a literal only as the fallback for a page without the tokens.
 */
const COMPANION_PAPER = 'var(--fcg-bg-base, #f9f9f9)'

/**
 * Edge of the character for a column of this width.
 *
 * Linear in the column with a floor and a ceiling: proportional reads as "sized
 * for this panel", while a floor keeps it legible in a narrow column and a
 * ceiling keeps it from becoming the page's largest element on a wide one.
 * @param columnWidth - measured width of the conversation column, in pixels.
 * @returns the square edge to draw at, in pixels.
 */
export function companionSize(columnWidth: number): number {
  return Math.round(Math.min(COMPANION_MAX_PX, Math.max(COMPANION_MIN_PX, columnWidth / COMPANION_COLUMN_SHARE)))
}

/**
 * Whether a pose is one of the engine's quiet ends.
 *
 * `idle` is the resting circle and `sleep` is where a session that has been quiet
 * for a minute and a half goes. Both mean "nothing is happening", so both draw
 * quiet — the row is deliberately still on screen for them, because taking it away
 * is what would move everything above it.
 * @param state - the pose the ladder settled on.
 * @returns whether the strip should draw in its resting look.
 */
export function companionAtRest(state: StateId): boolean {
  return state === 'idle' || state === 'sleep'
}

/**
 * Track the width of the column a full-width element is laid out in.
 *
 * The element measures itself, so nothing here needs to know how the shell is
 * built. The width is read synchronously on attach as well as reported by the
 * observer, because an observer's first callback is asynchronous and the first
 * frame would otherwise draw at the floor size and jump.
 * @returns the callback ref to attach, and the last measured width in pixels.
 */
function useColumnWidth(): { ref: (node: HTMLElement | null) => void; width: number } {
  const [width, setWidth] = useState(0)
  const observerRef = useRef<ResizeObserver | undefined>(undefined)
  const ref = useCallback((node: HTMLElement | null): void => {
    // React reports a removal as `null` and always before the next attach, so
    // this is the one place an observation ends.
    if (node === null) {
      observerRef.current?.disconnect()
      observerRef.current = undefined
      return
    }
    // Read the size we already have: an observer's first callback is asynchronous,
    // and the first painted frame would otherwise draw at the floor size and jump.
    setWidth(node.getBoundingClientRect().width)
    // A realm without ResizeObserver keeps the width it measured once and simply
    // does not follow a resize, which is the honest degradation: no observer, no
    // resize tracking, rather than a guessed size.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry === undefined) return
      setWidth(entry.contentRect.width)
    })
    observerRef.current = observer
    observer.observe(node)
  }, [])
  return { ref, width }
}

/** Full props of the dock entry: the Owner share, the standard kit, and the label seat. */
export type CompanionBarProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<typeof NS>

/**
 * The agent's face, full width, above the composer.
 * @param props - the dock entry's runtime props.
 * @returns the strip. It is always mounted while a session is open, so that
 * nothing it shows can move the composer it sits above.
 */
export function CompanionBar(props: CompanionBarProps) {
  const { session, t } = props
  // The row describes the session it was rendered for, and the facts behind the
  // pose come from the shared kit — the same ones the rail mark reads, so the two
  // surfaces cannot disagree about what the agent is doing.
  const observation = useCompanionObservation(props, session.sessionId)
  const view = useCompanionView(observation)
  const { ref, width } = useColumnWidth()
  return (
    <div
      ref={ref}
      className={css.root}
      role="status"
      data-fcg-companion="bar"
      data-fcg-companion-state={view.state}
      // No `hidden`/unmount at rest: the lane is always here, so the composer
      // stack above which it sits has one height for the whole session.
      data-fcg-companion-rest={String(companionAtRest(view.state))}
    >
      <CompanionSvg
        frame={view.frame}
        size={companionSize(width)}
        state={view.state}
        ink={COMPANION_INK}
        paper={COMPANION_PAPER}
        className={css.mark}
      />
      <span className={css.label}>{t(view.state)}</span>
    </div>
  )
}

/**
 * Dock the companion strip in the composer's entry list.
 *
 * A `list` slot takes many occupants, so this adds a fourth entry at a new `id`
 * rather than shadowing one: upstream's todo, goal, and queue strips keep their
 * seats and their order. `slots.inject` waits for the slot's declaration instead
 * of assuming an apply order, and the entry leaves with this plugin's fiber.
 * @param ctx - client root context.
 */
export function installCompanionBar(ctx: ClientContext): void {
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'freecodego-companion',
    order: COMPANION_DOCK_ORDER,
    locale: NS,
    registrant: 'freecodego-companion',
  }, CompanionBar))
}
