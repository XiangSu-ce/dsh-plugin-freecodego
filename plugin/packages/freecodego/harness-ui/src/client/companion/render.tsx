/**
 * Frame → SVG for the FreeCodeGo companion.
 *
 * The engine (`./engine/engine.ts`) is a pure function of time and knows nothing
 * about rendering, so this module is the whole browser half of the picture. It
 * follows the upstream project's own reference renderer (its Vue component) on
 * the two decisions that are not obvious:
 *
 * - **The eyes are holes, not shapes.** The body is one `<rect>` of ink masked by
 *   the silhouette with the eyes punched out of it. That is why the eyes stay
 *   correctly clipped when they slide to the edge of the silhouette, and it is
 *   why they need no clipping code of their own.
 * - **The silhouette is drawn twice.** The mask leaves real holes, so anything
 *   painted *behind* the body (the back half of an orbit, the burst particles)
 *   would show through them. An opaque backing at the exact silhouette, filled
 *   with the surface colour, is what keeps an orbit from reappearing inside the
 *   eyes. `paper` is that colour; see the note on `CompanionSvgProps.paper`.
 *
 * Deliberate differences from the reference renderer:
 *
 * - **A slot floor, with the surplus driven to opacity 0.** Arc, dot, and eye
 *   counts change frame to frame — `orbit` carries one to six rings, `burst` one to
 *   four particles, and two poses that overlap mid-morph concatenate their decor —
 *   so the renderer mounts a floor's worth of slots and empties the unused ones
 *   rather than mounting and unmounting paths mid-animation. Slots are keyed by
 *   index, so a frame that needs *more* than the floor appends at the tail and
 *   leaves the existing elements alone.
 *   The floor is **not** a truncation ceiling: a frame is always drawn in full.
 *   The bound is hard to state in closed form because it is a chain rather than a
 *   pair — `setState` during a morph freezes the *composite* pose, which may
 *   itself contain an earlier freeze — so the floor is a measured figure (see the
 *   test in `companion-render-slots.client.spec.tsx`) and anything past it still
 *   renders instead of disappearing.
 * - **Ink follows the theme.** `ink` defaults to `currentColor`, so the body takes
 *   the surrounding text colour and the companion reads correctly in a dark
 *   theme, where the engine's own `encre` (#0a0a0c) would sink into the surface.
 */
import { useId } from 'react'
import type { BotFrame } from './engine/engine.ts'
import { DEMI_VIEWBOX, RAYON } from './engine/repere.ts'
import { NOTIF_BLUE, type DotRender } from './engine/decor.ts'
import { mixHex } from './engine/skins.ts'
import type { StateId } from './engine/states.ts'

/**
 * Rings mounted when a frame needs no more than this: a measured figure, kept so
 * the common case never remounts a ring. See the module note; it is a floor, not
 * a ceiling.
 */
const ARC_SLOT_FLOOR = 12
/** Particles mounted when a frame needs no more than this. A floor, not a ceiling. */
const DOT_SLOT_FLOOR = 8
/** Eyes mounted when a frame needs no more than this. A floor, not a ceiling. */
const EYE_SLOT_FLOOR = 2

/**
 * Slots to mount for one frame's worth of decor.
 *
 * The floor keeps the element count stable for the ordinary pose change, and
 * anything past it is still drawn — a frame is never silently cut down to the
 * floor, which is the failure this function exists to prevent.
 * @param floor - slots to mount when the frame is small.
 * @param needed - decor the frame actually carries.
 * @returns the number of slots to render.
 */
function slotsFor(floor: number, needed: number): number {
  return Math.max(floor, needed)
}

const VB = DEMI_VIEWBOX

/** Props of the companion drawing. */
export interface CompanionSvgProps {
  /** One engine frame. Render-only; the caller owns the clock. */
  frame: BotFrame
  /** Square edge in pixels. The viewBox scales, so the drawing stays vector. */
  size: number
  /**
   * The body colour. Defaults to `currentColor` so the companion inherits the
   * surrounding text colour. `encre` (#0a0a0c) would disappear on a dark surface.
   */
  ink?: string
  /**
   * The surface colour behind the companion, used for the opaque backing that
   * keeps back-half decor from showing through the eye holes. It only has to be
   * right when the state paints something behind the body — an orbit or a burst;
   * at rest it is not visible at all.
   */
  paper?: string
  /** Accessible name. Omitted means decorative, which is how a brand mark is used. */
  label?: string
  /**
   * Class for the root `<svg>`, so the host can size or animate it in CSS.
   *
   * Admits an explicit `undefined` because a seat's class comes from a CSS
   * module, whose lookups are typed as possibly absent.
   */
  className?: string | undefined
  /**
   * Which pose is showing, published as `data-fcg-state`. Observability only:
   * the frame is the truth, and this is the name of the state that produced it.
   */
  state?: StateId
}

/** A colour we can mix; `currentColor` and `var(...)` deliberately are not. */
function mixable(color: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(color)
}

/**
 * Fill of one particle.
 *
 * `depth` is the engine's depth haze — a particle recedes into the surface as it
 * falls inward — and only the renderer can apply it, because only the renderer
 * knows the chosen colours. It is applied two ways, for one reason: the seats pass
 * **theme tokens** (`var(--fcg-text-primary)`) so the character follows light and
 * dark, and a token's value is not knowable here. Literal hex is mixed in TS, in
 * parity with the reference renderer; anything symbolic is handed to CSS, whose
 * `color-mix` resolves the tokens at paint time. Without that second path the haze
 * would be dropped in the only place this ships, since both seats pass tokens.
 *
 * Exported because it is the whole of that decision and needs no DOM to assert.
 * @param color - the particle's own colour, when the engine gave it one.
 * @param depth - 0 = fully receded into the surface, 1 = fully in front of it.
 * @param ink - the particle colour at full depth.
 * @param paper - the surface colour the particle recedes into.
 * @returns a CSS colour, or a `color-mix()` expression when a token is involved.
 */
export function dotFill(color: string | undefined, depth: number | undefined, ink: string, paper: string): string {
  if (color !== undefined) return color
  if (depth === undefined) return ink
  if (mixable(ink) && mixable(paper)) return mixHex(paper, ink, depth)
  return `color-mix(in srgb, ${paper} ${((1 - depth) * 100).toFixed(1)}%, ${ink})`
}

/** One frame of the companion, drawn as SVG. */
export function CompanionSvg(props: CompanionSvgProps) {
  const { frame, size, ink = 'currentColor', paper = '#f9f9f9', label, className, state } = props
  const uid = useId().replace(/:/g, '')
  const maskId = `fcg-companion-mask-${uid}`

  const arcs = frame.arcs
  const dots = frame.dots
  const eyes = frame.eyes
  // Grown to the frame, never cut to the floor: a pose that stacks more decor than
  // any measured chain does is drawn in full rather than losing a ring.
  const arcSlots = slotsFor(ARC_SLOT_FLOOR, arcs.length)
  const dotSlots = slotsFor(DOT_SLOT_FLOOR, dots.length)
  const eyeSlots = slotsFor(EYE_SLOT_FLOOR, eyes.length)

  return (
    <svg
      className={className}
      data-fcg-state={state}
      width={size}
      height={size}
      viewBox={`${-VB} ${-VB} ${VB * 2} ${VB * 2}`}
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
    >
      <defs>
        {/* Holes: white keeps, black cuts. See the module note. */}
        <mask id={maskId} maskUnits="userSpaceOnUse" x={-VB} y={-VB} width={VB * 2} height={VB * 2}>
          <path d={frame.bodyPath} fill="#fff" />
          {Array.from({ length: eyeSlots }, (_, i) => {
            const eye = eyes[i]
            return (
              <path
                key={`eye${i}`}
                d={eye?.d ?? ''}
                transform={eye?.matrix}
                opacity={eye?.alpha ?? 0}
                fill="#000"
              />
            )
          })}
          {frame.notch === null ? null : (
            <circle cx={frame.notch.x} cy={frame.notch.y} r={frame.notch.r} fill="#000" />
          )}
        </mask>

        {/* One gradient per arc slot, so a changing arc set never renumbers an id. */}
        {Array.from({ length: arcSlots }, (_, i) => {
          const grad = arcs[i]?.grad
          return (
            <linearGradient
              key={`grad${i}`}
              id={`${maskId}-g${i}`}
              gradientUnits="userSpaceOnUse"
              x1={grad?.x1 ?? 0}
              y1={grad?.y1 ?? 0}
              x2={grad?.x2 ?? 0}
              y2={grad?.y2 ?? 0}
            >
              {(grad?.stops ?? ['#000']).map((stop, s, all) => (
                <stop key={s} offset={all.length === 1 ? 0 : s / (all.length - 1)} stopColor={stop} />
              ))}
            </linearGradient>
          )
        })}
      </defs>

      {/* Back half of the rings, drawn before the body so the body occludes it. */}
      <g fill="none" strokeLinecap="round">
        {Array.from({ length: arcSlots }, (_, i) => {
          const arc = arcs[i]
          return (
            <path
              key={`back${i}`}
              d={arc?.back ?? ''}
              stroke={arc === undefined ? 'none' : `url(#${maskId}-g${i})`}
              strokeWidth={arc?.width ?? 0}
              opacity={arc?.opacity ?? 0}
            />
          )
        })}
      </g>

      {/* Particles that belong behind the nucleus (the burst). */}
      <g opacity={frame.dotsBehind ? 1 : 0}>
        {Array.from({ length: dotSlots }, (_, i) => (
          <Dot key={`behind${i}`} dot={dots[i]} ink={ink} paper={paper} />
        ))}
      </g>

      <g opacity={frame.bodyAlpha}>
        {/* Opaque backing at the silhouette: without it a back-half ring shows through the eyes. */}
        <path d={frame.bodyPath} style={{ fill: paper }} />
        <g mask={`url(#${maskId})`}>
          <rect x={-VB} y={-VB} width={VB * 2} height={VB * 2} style={{ fill: ink }} />
        </g>
      </g>

      {/* Particles that belong in front of the nucleus. */}
      <g opacity={frame.dotsBehind ? 0 : 1}>
        {Array.from({ length: dotSlots }, (_, i) => (
          <Dot key={`front${i}`} dot={dots[i]} ink={ink} paper={paper} />
        ))}
      </g>

      {frame.notif === null ? null : (
        <circle cx={frame.notif.x} cy={frame.notif.y} r={frame.notif.r} fill={NOTIF_BLUE} />
      )}

      {/* Front half of the rings. */}
      <g fill="none" strokeLinecap="round">
        {Array.from({ length: arcSlots }, (_, i) => {
          const arc = arcs[i]
          return (
            <path
              key={`front${i}`}
              d={arc?.front ?? ''}
              stroke={arc === undefined ? 'none' : `url(#${maskId}-g${i})`}
              strokeWidth={arc?.width ?? 0}
              opacity={arc?.opacity ?? 0}
            />
          )
        })}
      </g>
    </svg>
  )
}

/**
 * One particle slot. An unused slot renders a zero-opacity empty circle, which
 * draws nothing and costs no remount when the frame's particle count changes.
 */
function Dot(props: {
  dot: DotRender | undefined
  ink: string
  paper: string
}) {
  const { dot, ink, paper } = props
  if (dot === undefined) return <circle cx={0} cy={0} r={0} opacity={0} />
  const fill = dotFill(dot.color, dot.depth, ink, paper)
  if (dot.d === undefined) {
    return <circle cx={dot.x} cy={dot.y} r={dot.r} style={{ fill }} opacity={dot.opacity} />
  }
  /* A shaped particle is authored in ball-radius units centred on the origin,
     so the renderer supplies the scale — the engine never knows the viewBox. */
  return (
    <path
      d={dot.d}
      transform={`translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${RAYON})`}
      style={{ fill }}
      opacity={dot.opacity}
    />
  )
}
