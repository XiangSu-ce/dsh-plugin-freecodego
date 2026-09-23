/**
 * The companion's fourth seat: the transcript's own running rows.
 *
 * Inside a turn, upstream animates every row that is still working with one
 * *sweep*: a translucent band glides across the row from off-left to off-right,
 * washing its glyphs toward the background as it passes. Measured on the synced
 * client, that single idiom is spelled twice — `dsh-reasoning-row-sweep`
 * (`ReasoningRow`) and its own class on `ui-skill`'s row — and it is always the *same
 * shape*: an animated `::after` painted on a row element *inside* the running
 * element.
 *
 * Five spellings did when this seat was measured: the revision that introduced the
 * turn-process row dropped the other three (`GenericCommandCard`, `ui-tool`'s
 * `ToolRow`, the bash row's own box) and moved the two that stayed one level in, from
 * the running element itself onto the `.row` inside it. Those three rows now keep the
 * shell's own look, which is the correct outcome here — there is no band left to
 * replace, so the character does not stand where an animation no longer passes.
 *
 * So this seat does not enumerate the spellings; it **finds the band**, by asking the
 * one question they all answer the same way: *which element inside this running row
 * paints an animated `::after`?* That is `findBandHost`, and the answer is also where
 * the character goes, because the element that paints the row is the row. Another
 * sweep upstream — a new spelling, a renamed keyframe, a different row component — is
 * covered on the same pass, and a band that moves from a pseudo-element to a real
 * element stops being found, which the stylesheet gate in
 * `tests/companion-step-row.client.spec.tsx` fails on rather than silently keeping
 * the sweep.
 *
 * The seat's decisions:
 *
 * - **The row keeps everything and loses the sweep.** Height, padding, leading
 *   icon, title, summary, chevron, and the visually-hidden "运行中" all stay
 *   upstream's; only the band is switched off. The row is still legible as *working*
 *   because its own summary says so and because the character now stands where the
 *   sweep used to pass.
 * - **The character goes at the leading edge, and the icon stays.** The face is
 *   prepended, before the row's kind icon: status reads from the start of the row,
 *   and the icon is not ours to spend — it names what the row is (`think`, `bash`,
 *   `read`), which no character can say.
 * - **18px, because the row is 24px.** The sweep's row is
 *   `height: calc(24px + delta)` with a `16px` leading box (measured from
 *   `DisclosureRow.module.css`), and the transcript's status row carries a 20px
 *   face in 26px. 18 in 24 is the same three pixels of breathing room, so the face
 *   cannot grow the row it was inserted into — the one failure that matters here,
 *   because these rows are laid out in the transcript's flow.
 * - **A row that already shows the shell's ongoing dot keeps its own mark.** The
 *   dot is an in-flight mark in the row's leading slot, and the character's place is
 *   *that mark's place* rather than a second one beside it, so those rows are left to
 *   `./dot-row.tsx` — one character per row, standing where the shell was animating.
 *   The test is that seat's own (`inConversationSurface`): a dot it will not take
 *   over is not a mark being handed over either.
 * - **A step row does not claim the drawing.** `./running-row-presence.ts` decides
 *   which *surface* holds the character, and a step row is not a surface: the strip
 *   above the composer yields to the session-level status row, not to each command
 *   that happens to be running. What these rows get is the character in place of
 *   their own animation, one per row that is still working.
 */
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { ensureTakeoverStyle, installTakeover, prependFace } from './row-takeover.ts'
import { ONGOING_DOT_SELECTOR, inConversationSurface } from './dot-row.tsx'
import type { CompanionActivitySource } from './activity.ts'
import { StoreFace, type StoreFaceSources } from './store-face.tsx'

/**
 * The rows this seat takes over: anything the shell is drawing as *running* that
 * paints a sweep.
 *
 * Scoped on the running state rather than on a row kind on purpose: a new kind of
 * running row is looked at instead of being silently missed, and every settled row —
 * whose state is `ok` or `error` — is left exactly as upstream drew it. A running
 * element that paints no band and shows no dot (a session row, `StateDot`'s own
 * wrapper) resolves to nothing and is left unmarked, so a later pass can still take
 * it if it ever grows either.
 */
export const STEP_ROW_SELECTOR = '[data-state="running"]'

/** A row header that is *declared* to be one. The fast path; see {@link findBandHost}. */
const DISCLOSURE_ROW_SELECTOR = '[data-disclosure-row]'

/** Marks the band's host as taken over. Styling and the re-scan both key on it. */
export const STEP_ROW_ATTR = 'data-fcg-companion-step'

/** Marks the injected container, so a re-scan can find one it already mounted. */
export const STEP_ROW_FACE_ATTR = 'data-fcg-companion-step-face'

/** Marks the injected stylesheet, so repeated installs share one sheet. */
const STYLE_ATTR = 'data-fcg-step-row-style'

/** Class of the container the face is mounted into. Named, not hashed: it is ours. */
const FACE_CLASS = 'fcg-step-row'

/**
 * Edge of the character inside a step row, in pixels.
 *
 * The row is 24px tall with a 16px leading box, so this is the transcript status
 * row's own ratio (20 in 26) at this row's height: three pixels of air above and
 * below, and a drawing that cannot grow the row.
 */
export const STEP_ROW_FACE_PX = 18

/**
 * Whether this element paints the sweep band on its own `::after`.
 *
 * The band is upstream's own idiom and it is a pseudo-element, so the sweep cannot
 * be recognised from the DOM — only from what the engine computed for it. Both
 * halves of the signature are read, because each alone is too loose: `content`
 * matches any decorative pseudo-element in the row, and an animation without a box
 * (`content: none`) paints nothing at all.
 *
 * The name is deliberately *not* compared against `dsh-*-row-sweep`: a CSS module
 * hashes its `@keyframes`, so the name in the sheet is not the name in the style.
 */
export type BandProbe = (element: HTMLElement) => boolean

/** The real probe: an `::after` that has both a box and an animation. */
export const paintsBand: BandProbe = (element) => {
  try {
    const after = window.getComputedStyle(element, '::after')
    return after.content !== 'none' && after.content !== 'normal' && after.animationName !== 'none'
  } catch {
    // A detached element, or an engine that will not answer for pseudo-elements:
    // no band, and the row is left as upstream drew it.
    return false
  }
}

/**
 * Find the element a running row's sweep is painted on.
 *
 * A declared row header wins outright — it is upstream's own marker (`ui-chat`'s
 * command and reasoning rows, `ui-tool`'s rows and `ui-deliverables`' present row
 * all render one) and costs no style resolution. Only when there is none does the
 * band have to be measured, which is the hand-rolled case: `ui-skill`'s row draws
 * its own sweep, and the bash row paints the band on its own box.
 * @param host - the element reporting `data-state="running"`.
 * @param probe - how to recognise the band; the real one in production.
 * @returns the band's host, or null when this row paints no band.
 */
export function findBandHost(host: HTMLElement, probe: BandProbe = paintsBand): HTMLElement | null {
  const declared = host.querySelector<HTMLElement>(DISCLOSURE_ROW_SELECTOR)
  if (declared !== null) return declared
  if (probe(host)) return host
  for (const candidate of host.querySelectorAll<HTMLElement>('*')) {
    if (probe(candidate)) return candidate
  }
  return null
}

/** What a caller may override; production passes nothing. */
export interface StepRowOptions {
  /** How to recognise the band. Overridden by the specs, which have no style engine. */
  readonly bandProbe?: BandProbe | undefined
}

/**
 * The sheet that switches the sweep off and lays the face out in its place.
 *
 * Keyed on the marker rather than on upstream's class names, which the bundle
 * hashes. `content: none` is what removes the band itself — the pseudo-element is
 * the sweep — and the animation is disabled beside it so nothing is left running
 * with no paint.
 */
const SHEET = `
  [${STEP_ROW_ATTR}]::after {
    content: none !important;
    animation: none !important;
  }
  .${FACE_CLASS} {
    display: inline-flex;
    flex: none;
    align-items: center;
    margin-right: 6px;
    color: var(--fcg-text-primary);
  }
`

/**
 * Seat the companion in the transcript's running rows.
 * @param ctx - client root context, carrying the Session sources.
 * @param activity - the plugin's one live event feed, so this seat's face and the
 * two slot seats read the same phases at the same instant.
 * @param options - the band probe, overridden only by the specs.
 * @returns a disposer that stops watching and unmounts every injection.
 */
export function installStepRows(
  ctx: ClientContext,
  activity: CompanionActivitySource,
  options: StepRowOptions = {},
): () => void {
  const probe = options.bandProbe ?? paintsBand
  const sources: StoreFaceSources = {
    sessions: ctx.sessions.list,
    jobs: ctx.jobs.state,
    statuses: ctx.uiSession.sessionStatus,
    activity,
  }
  ensureTakeoverStyle(STYLE_ATTR, SHEET)
  return installTakeover({
    selector: STEP_ROW_SELECTOR,
    mark: STEP_ROW_ATTR,
    takeOver: (running: HTMLElement): () => void => {
      // The row's own in-flight mark is the shell's ongoing dot, so the character's
      // place is that mark's slot, and `./dot-row.tsx` puts it there. Marking this
      // row as well would draw a second one beside it. Asked through that seat's own
      // predicate rather than around it: a dot the dot seat will not take over (one
      // outside the conversation) is not a mark this row is handing over either.
      const mark = running.querySelector(ONGOING_DOT_SELECTOR)
      if (mark !== null && inConversationSurface(mark)) return () => {}
      const band = findBandHost(running, probe)
      if (band === null) return () => {}
      band.setAttribute(STEP_ROW_ATTR, 'true')
      const release = prependFace(band, STEP_ROW_FACE_ATTR, FACE_CLASS, (container) => {
        const root = createRoot(container)
        root.render(<StepRowFace sources={sources} />)
        return () => { root.unmount() }
      })
      return () => {
        release()
        band.removeAttribute(STEP_ROW_ATTR)
      }
    },
  })
}

/**
 * The character as a running step row shows it.
 * @param props.sources - the session list and status observables.
 * @returns the face, sized for the row.
 */
function StepRowFace({ sources }: { readonly sources: StoreFaceSources }): ReactNode {
  return <StoreFace sources={sources} size={STEP_ROW_FACE_PX} className={`${FACE_CLASS}-mark`} />
}
