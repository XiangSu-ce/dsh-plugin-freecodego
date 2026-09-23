/**
 * The companion's fifth seat: the shell's *ongoing* dot.
 *
 * `StateDot` draws the shell's in-flight mark in two forms — a solid disc for the
 * settled outcomes, and, for `state="ongoing"`, a spinner: a ring whose arc breathes
 * on `dsh-state-dot-dash` while the glyph rotates on `dsh-state-dot-spin`, both on
 * one shared 1.5s period. That second form is the shell's *loading animation* away
 * from the row sweeps, and it is exactly one element in the document —
 * `svg[data-state="ongoing"]`, which only `StateDot` emits (its other states are a
 * `span`, and a settled state is an outcome colour, not an animation, so those are
 * left alone).
 *
 * The mark was eight chasing `rect` cells on `dsh-state-dot-chase` when this seat was
 * measured; the shell replaced that with the ring, which is why nothing here reads a
 * cell, a frame, or a keyframe name. The seat never depended on the drawing — it takes
 * over the element, not its animation — but the stylesheet gate in
 * `tests/companion-dot-row.client.spec.tsx` pins the shape that was replaced, so that
 * gate is what has to move when the shell redraws the mark.
 *
 * The seat's decisions:
 *
 * - **The dot's box is kept, not its animation.** The character is mounted where the
 *   dot was, in the dot's own slot, and the dot itself is switched off
 *   (`display: none`) rather than removed. Two reasons, and they point the same way:
 *   the mark sits in a flex/inline slot whose row height is text-driven, so nothing
 *   moves; and React keeps owning the node it rendered — when the mark goes away,
 *   React removes *it*, and this seat sees the removal and releases the character
 *   with it. Deleting a node React owns is the one thing this must not do.
 * - **The dot's own classes are carried over.** The layout class belongs to the
 *   callsite, not to the dot (`triggerDot`, `rowDot` and friends are all just
 *   `flex: none`), and the sheet cannot name a hashed class — so the container takes
 *   the class list the svg had. Spacing around the mark is therefore unchanged.
 * - **14px, whatever the dot was.** The marks this replaces are 8px (the plugin
 *   manager's rows) and 10px (everything else) — measured — and the character has to
 *   read as itself, which it does from about 14px. The slot it fills is an inline
 *   mark beside text, so four extra pixels of width move nothing; the row's leading
 *   box in the transcript is 16px, which a 14px face sits inside with the same
 *   breathing room the 10px dot had.
 * - **A row that paints a sweep keeps the dot as the row's mark.** The other
 *   direction of the hand-off in `./step-row.tsx`: a row with a band puts the
 *   character at the band's leading edge, and a row whose only in-flight mark is the
 *   dot puts it in the dot's slot. Neither happens twice in one row.
 * - **Only the conversation's own chrome.** The dot is also the shell's in-flight
 *   mark away from the conversation — a plugin fiber loading in the settings pages
 *   draws one — and the character does not speak for those: it is the *agent's*
 *   mark, and a package being installed is not the agent working. So this seat
 *   holds itself to the conversation the character belongs to, by the shell's own
 *   published anchors, and a settings page keeps the dot upstream drew.
 */
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { ensureTakeoverStyle, installTakeover } from './row-takeover.ts'
import type { CompanionActivitySource } from './activity.ts'
import { StoreFace, type StoreFaceSources } from './store-face.tsx'

/**
 * The shell's animated in-flight mark. Only `StateDot`'s `ongoing` branch emits an
 * `svg` with a state attribute; its other four states are a `span`, and no row or
 * table that reports `data-state` does so on an svg.
 */
export const ONGOING_DOT_SELECTOR = 'svg[data-state="ongoing"]'

/**
 * The conversation's own chrome, by the shell's published anchors.
 *
 * `[data-conversation-content]` is the body — transcript, composer and queue dock
 * all live inside it — and the other two are the scrollport and the chat column
 * within it. They are listed beside it on purpose: each is an anchor the shell
 * already publishes (the chat seats read them too), so the seat survives a layout
 * refactor that moves one of them out of the body, without ever matching a page
 * that merely happens to contain a menu.
 */
export const CONVERSATION_SURFACE = [
  '[data-conversation-content]',
  '[data-conversation-scroll]',
  '[data-chat-flow]',
].join(', ')

/**
 * Whether an element belongs to the conversation the character speaks for.
 *
 * The body and the scrollport are found upwards from the dot; the session header
 * publishes no marker on itself, so it is recognised as the nearest ancestor that
 * holds its own slots (a settings page's `<header>` holds none, and is not the
 * conversation's).
 *
 * The ancestor *tag* used to be part of this test — the header was a `header`
 * element, and requiring it was the belt to the slots' braces. The shell then rewrote
 * the header as `div.titleRow`, at which point the tag check stopped recognising the
 * header at all: the jobs mark in its `actions` seat fell out of the conversation and
 * the seat ignored it. The slots are the marker that survived the rewrite, so they are
 * the whole test — they are also the exclusion the tag was being read for, because no
 * other header in the shell holds them.
 * @param element - the element to place; the dot, or the row considering it.
 * @returns true when the element is inside the conversation's chrome.
 */
export function inConversationSurface(element: Element): boolean {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    if (node.matches(CONVERSATION_SURFACE)) return true
    if (node.querySelector(HEADER_SLOT_SELECTOR) !== null) return true
  }
  return false
}

/**
 * The session header's own slots. Its `actions` seat — where the jobs list's dot
 * lives — carries no marker, so the header is recognised by the slots around it.
 *
 * Only the corner is emitted by the current shell: the leading marker went with the
 * rewrite into `div.titleRow`. It is kept in the selector anyway, because a slot that
 * comes back should be recognised again rather than silently ignored — and the
 * stylesheet gate in the tests records which of the two is on disk today.
 */
const HEADER_SLOT_SELECTOR = '[data-conversation-header-leading], [data-conversation-header-corner]'

/** Marks the dot as switched off. Styling and the re-scan both key on it. */
export const DOT_ATTR = 'data-fcg-companion-dot'

/** Marks the injected container, so a re-scan can find one it already mounted. */
export const DOT_FACE_ATTR = 'data-fcg-companion-dot-face'

/** Marks the injected stylesheet, so repeated installs share one sheet. */
const STYLE_ATTR = 'data-fcg-dot-row-style'

/** Class of the container the face is mounted into. Named, not hashed: it is ours. */
const FACE_CLASS = 'fcg-dot-face'

/** Smallest edge the character is drawn at, whatever the dot measured. */
export const DOT_FACE_MIN_PX = 14

/** Largest edge it is drawn at. Every measured dot is 8–10px; this is a guard. */
export const DOT_FACE_MAX_PX = 20

/** The size `StateDot` uses when a callsite passes none. */
const DOT_FALLBACK_PX = 10

/**
 * The sheet that switches the dot off and lays the face out in its slot.
 *
 * Keyed on the marker rather than on upstream's class names, which the bundle
 * hashes. `display: none` rather than `content: none`: the mark is a real element
 * with a ring and its animations on it, and hiding it is what stops them — a hidden
 * subtree is no longer laid out or painted.
 */
const SHEET = `
  [${DOT_ATTR}] {
    display: none !important;
  }
  .${FACE_CLASS} {
    display: inline-flex;
    flex: none;
    align-items: center;
    color: var(--fcg-text-primary);
  }
`

/**
 * The edge to draw the character at, for the dot it replaces.
 * @param dot - the dot element, whose declared width is the shell's own size.
 * @returns the edge in pixels.
 */
export function faceEdgeFor(dot: Element): number {
  const declared = Number(dot.getAttribute('width'))
  const size = Number.isFinite(declared) && declared > 0 ? declared : DOT_FALLBACK_PX
  return Math.min(DOT_FACE_MAX_PX, Math.max(DOT_FACE_MIN_PX, size))
}

/**
 * Seat the companion in place of the shell's ongoing dots.
 * @param ctx - client root context, carrying the Session sources.
 * @param activity - the plugin's one live event feed, so this seat's face and the
 * two slot seats read the same phases at the same instant.
 * @returns a disposer that stops watching and unmounts every injection.
 */
export function installDotFaces(ctx: ClientContext, activity: CompanionActivitySource): () => void {
  const sources: StoreFaceSources = {
    sessions: ctx.sessions.list,
    jobs: ctx.jobs.state,
    statuses: ctx.uiSession.sessionStatus,
    activity,
  }
  ensureTakeoverStyle(STYLE_ATTR, SHEET)
  return installTakeover({
    selector: ONGOING_DOT_SELECTOR,
    mark: DOT_ATTR,
    takeOver: (dot: HTMLElement): () => void => {
      // A dot outside the conversation keeps its own mark, and is left unmarked so
      // nothing else has to know it was looked at.
      if (!inConversationSurface(dot)) return () => {}
      const edge = faceEdgeFor(dot)
      const container = document.createElement('div')
      // The dot's own class list, so the callsite's layout class comes with it.
      container.className = [FACE_CLASS, dot.getAttribute('class') ?? ''].join(' ').trim()
      container.setAttribute(DOT_FACE_ATTR, 'true')
      container.setAttribute('aria-hidden', 'true')
      dot.setAttribute(DOT_ATTR, 'true')
      dot.before(container)
      const root = createRoot(container)
      root.render(<DotFace sources={sources} edge={edge} />)
      return () => {
        root.unmount()
        container.remove()
        dot.removeAttribute(DOT_ATTR)
      }
    },
  })
}

/**
 * The character as the shell's in-flight mark shows it.
 * @param props.sources - the session list and status observables.
 * @param props.edge - the square edge to draw at, in pixels.
 * @returns the face, sized for the mark it replaced.
 */
function DotFace({ sources, edge }: {
  readonly sources: StoreFaceSources
  readonly edge: number
}): ReactNode {
  return <StoreFace sources={sources} size={edge} className={`${FACE_CLASS}-mark`} />
}
