/**
 * The companion's third seat: the running turn's own status row.
 *
 * Upstream draws the loading animation itself — `TurnStatus` in
 * `client/ui-chat`, one row of shimmering brand-blue text ("深度求索中...") that
 * rides the whole running turn, plus an elapsed clock after fifteen seconds.
 * There is no slot there: the row is a plain element inside the Chat view's own
 * column, and the column's slots (`conversation.chat.turnTail`, the keyed node
 * renderers) are either built only once a turn has *ended* or keyed by node kinds
 * upstream owns. So this seat is a widget-level injection, through
 * `./row-takeover.ts` — the same shape `../sidebar-icons.ts` and
 * `../native-model-menu-badges.ts` already use where the shell offers no
 * extension point, and the same machinery `./step-row.tsx` uses for the rows
 * inside the transcript.
 *
 * Three decisions are this seat's own:
 *
 * - **The row is taken over, not decorated.** The official row keeps its box, its
 *   height, its place in the column, its `role="status"` region and its clock —
 *   and loses only the animation: the shimmer is a text gradient, so the injected
 *   rule drops the gradient, the sweep, and the text's paint, and collapses the
 *   label's width to zero. The label stays in the DOM, so a screen reader still
 *   hears what the row says; a sighted reader gets the character instead of a
 *   sweeping band. Replacing the row's *element* instead would have cost the clock
 *   and the announcement, and moving the row would have moved the composer stack.
 * - **The face is the same face.** It is `./store-face.tsx` — the published view of
 *   `./view.ts`, over facts read from the same two stores the framework feeds the
 *   seats through their Hooks. That is what keeps the strip above the composer and
 *   the row in the transcript from ever disagreeing about what the agent is doing,
 *   which is the property both of them exist for.
 * - **One character at a time.** A mounted row claims the drawing
 *   (`./running-row-presence.ts`) for exactly as long as it is mounted, and the
 *   strip yields it while any claim stands. The row exists for the running turn,
 *   which is when the reader is looking at the end of the transcript, so that is
 *   where the character belongs; the strip keeps its lane and its words, so the
 *   handover moves nothing.
 *
 * The upstream selector is the one brittle fact here: it matches the Chat view's
 * own column (`data-chat-flow`) with a direct `role="status" aria-live="polite"`
 * child, which is the only such row in that view. If upstream renames either, the
 * row is left alone and the official animation stays — a graceful fall back to the
 * shipped behaviour rather than a broken one — and
 * `companion-running-row.client.spec.tsx` pins the selector against the upstream
 * source it was read from.
 */
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { CompanionActivitySource } from './activity.ts'
import { ensureTakeoverStyle, installTakeover, prependFace } from './row-takeover.ts'
import { claimRunningRowFace } from './running-row-presence.ts'
import { StoreFace, type StoreFaceSources } from './store-face.tsx'

/**
 * The upstream row this seat takes over: the Chat view's own turn-status line.
 *
 * A direct child of the column (`data-chat-flow`) that announces itself as a
 * polite status region. Scoping to the direct child is what keeps the turn-error
 * rows *inside* the node list — also `role="status"`, but nested — out of it.
 */
export const RUNNING_ROW_SELECTOR = '[data-chat-flow] > [role="status"][aria-live="polite"]'

/** Edge of the character inside the status row, in pixels. */
export const RUNNING_ROW_FACE_PX = 20

/** Marks the row as taken over. Styling and the re-scan both key on it. */
export const RUNNING_ROW_ATTR = 'data-fcg-companion-row'

/** Marks the injected container, so a re-scan can find one it already mounted. */
export const RUNNING_ROW_FACE_ATTR = 'data-fcg-companion-row-face'

/** Marks the injected stylesheet, so repeated installs share one sheet. */
const STYLE_ATTR = 'data-fcg-running-row-style'

/** Class of the container the face is mounted into. Named, not hashed: it is ours. */
const FACE_CLASS = 'fcg-running-row'

/**
 * The sheet that turns the official row into a host for the face.
 *
 * `!important` is deliberate and load-bearing here: the declarations override a
 * CSS-module class the bundle hashes, so this sheet cannot name it, and the two
 * selectors carry the same specificity. Only the paint is overridden — the row's
 * own box, height, and alignment stay upstream's.
 */
const SHEET = `
  [${RUNNING_ROW_ATTR}] {
    background: none !important;
    animation: none !important;
    color: transparent !important;
    -webkit-text-fill-color: transparent !important;
    font-size: 0 !important;
    gap: 8px;
  }
  .${FACE_CLASS} {
    display: inline-flex;
    flex: none;
    align-items: center;
    color: var(--fcg-text-primary);
  }
`

/**
 * Seat the companion in the running turn's status row.
 * @param ctx - client root context, carrying the Session sources.
 * @param activity - the plugin's one live event feed, so this seat's face and the
 * two slot seats read the same phases at the same instant.
 * @returns a disposer that stops watching and unmounts every injection.
 */
export function installRunningRow(ctx: ClientContext, activity: CompanionActivitySource): () => void {
  const sources: StoreFaceSources = {
    sessions: ctx.sessions.list,
    jobs: ctx.jobs.state,
    statuses: ctx.uiSession.sessionStatus,
    activity,
  }
  ensureTakeoverStyle(STYLE_ATTR, SHEET)
  return installTakeover({
    selector: RUNNING_ROW_SELECTOR,
    mark: RUNNING_ROW_ATTR,
    takeOver: (row: HTMLElement): () => void => {
      // The claim is taken before the mount, so the strip yields on the same pass
      // that the row starts drawing rather than a frame later.
      const releaseClaim = claimRunningRowFace()
      row.setAttribute(RUNNING_ROW_ATTR, 'true')
      const release = prependFace(row, RUNNING_ROW_FACE_ATTR, FACE_CLASS, (container) => {
        const root = createRoot(container)
        root.render(<RunningRowFace sources={sources} />)
        return () => { root.unmount() }
      })
      return () => {
        release()
        releaseClaim()
        row.removeAttribute(RUNNING_ROW_ATTR)
      }
    },
  })
}

/**
 * The character as the transcript's status row shows it.
 * @param props.sources - the session list and status observables.
 * @returns the face, sized for the row.
 */
function RunningRowFace({ sources }: { readonly sources: StoreFaceSources }): ReactNode {
  return <StoreFace sources={sources} size={RUNNING_ROW_FACE_PX} className={`${FACE_CLASS}-mark`} />
}
