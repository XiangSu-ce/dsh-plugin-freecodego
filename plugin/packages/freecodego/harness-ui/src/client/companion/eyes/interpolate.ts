/**
 * Point-by-point interpolation between two eye outlines.
 *
 * The outlines in `./rings.ts` are all sampled at the same parameters in the same
 * order, which is what makes a morph between two of them a one-liner rather than a
 * correspondence problem: point `i` of one is point `i` of the other. That sameness
 * is the whole reason the shapes are generated from formulas instead of stored as
 * point lists.
 *
 * Only the interpolation lives here. Easing, duration and where a morph starts
 * belong to the caller, because the caller is the one that knows whether it is
 * driving a blink (fast, symmetric), a state change (the engine's own morph curve),
 * or a pool rotation.
 *
 * @module client/companion/eyes/interpolate
 */
import { clamp } from '../engine/math.ts'
import { RING_SAMPLES, type Ring } from './rings.ts'

/**
 * The outline `t` of the way from one shape to another.
 *
 * `t` is clamped, so a caller that overshoots an animation's end gets the end shape
 * rather than a reflection of it. Points are interpolated in the normalised box the
 * outlines are written in, which means a morph between shapes of different bulk
 * passes smoothly through the in-between rather than scaling about the centre.
 *
 * At the two ends the outline is handed back untouched. Recomputing it would be a
 * last-bit difference — `a + (b - a)` is not always `b` — and a morph is driven by a
 * ratio that *lands* on one and stays there, so the finished eye would differ from
 * its destination by a fraction of a pixel it can never shake off.
 * @param from - the outline at `t = 0`.
 * @param to - the outline at `t = 1`.
 * @param t - how far along, 0 to 1.
 * @returns the interpolated outline, always {@link RING_SAMPLES} points long.
 */
export function lerpRing(from: Ring, to: Ring, t: number): Ring {
  const k = clamp(t)
  if (k === 0) return from
  if (k === 1) return to
  const out: { x: number; y: number }[] = []
  for (let i = 0; i < RING_SAMPLES; i++) {
    const a = from[i]
    const b = to[i]
    /* v8 ignore next -- every ring is built by `sample`, so both are always full */
    if (a === undefined || b === undefined) break
    out.push({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k })
  }
  return out
}
