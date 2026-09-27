/**
 * Drawing a ring where the engine drew a capsule.
 *
 * The engine places eyes and knows nothing about their outline: it hands over a path,
 * a matrix and an opacity, and the renderer draws whatever it is given (`./render.tsx`
 * punches it out of the body as a hole). So replacing an eye's shape is a matter of
 * replacing one string — and this module is the whole of that.
 *
 * The one thing the frame does not say
 * ------------------------------------
 * An eye's `d` is written **at the box the engine chose** (`capsulePath(w, h)` in
 * viewBox units), and the matrix applies the sphere's tangent frame, the per-eye tilt
 * and the blink to it. Which means the shape and the box are both inside `d`, and an
 * outline in normalised coordinates needs the box to be scaled into place. The frame
 * states the shape and not the box, so the box is read back out of the capsule the
 * engine wrote — which is exact, because a capsule is written as its own box:
 *
 *     M-x -y+r  A r r 0 0 1 -x+r -y  L x-r -y  A r r 0 0 1 x -y+r  …
 *
 * The horizontal and vertical extremes appear as coordinates in the `M` and `L`
 * commands, so measuring them is arithmetic rather than guesswork. The `A` commands are
 * skipped deliberately: their arguments are a radius and two flags, and a flag of `1`
 * in a path whose box is under two units across would be mistaken for an extreme.
 *
 * Reading a path back is only sound because the format cannot drift: `engine/` is
 * vendored, `PROVENANCE.md` pins every file by hash, and the notices gate refuses a
 * vendored package whose provenance is missing. A change to that format is a deliberate
 * act with a review attached, and the test beside this module covers a grid of boxes so
 * it is caught rather than rediscovered on screen.
 *
 * @module client/companion/eyes/apply
 */
import type { BotFrame } from '../engine/engine.ts'
import { ringPath, type Ring } from './rings.ts'

/** A coordinate pair, as the engine's own path writer emits it. */
const COORDINATES = /[ML][^MLAZ]*/gu
/** One number, with the optional sign and fraction `r2` writes. */
const NUMBER = /-?\d+(?:\.\d+)?/gu

/**
 * The box an eye was drawn at, in viewBox units.
 *
 * Only the `M` and `L` commands are read; see the module note for why the arcs are
 * skipped.
 * @param capsule - an eye path as the engine wrote it.
 * @returns the box's full width and height, zero if there was no path at all.
 */
export function eyeBox(capsule: string): { w: number; h: number } {
  let x = 0
  let y = 0
  for (const command of capsule.match(COORDINATES) ?? []) {
    // A move and a line each carry exactly one coordinate pair, so position in the
    // list *is* the axis: evens are x, odds are y. Walking the list rather than
    // stepping over it is what keeps this free of an index that has to be asserted.
    for (const [at, value] of (command.slice(1).match(NUMBER) ?? []).entries()) {
      const magnitude = Math.abs(Number(value))
      if (at % 2 === 0) x = Math.max(x, magnitude)
      else y = Math.max(y, magnitude)
    }
  }
  return { w: x * 2, h: y * 2 }
}

/**
 * The same frame, with every eye drawn in the given outline instead of its capsule.
 *
 * Only the eye paths change. Their matrices, their depths, their opacities, the
 * silhouette, and the decor are the engine's and stay exactly as they were, which is
 * what makes the rings a change of vocabulary rather than a second renderer: an outline
 * that is going behind the sphere still goes behind it, and one being blinked over still
 * squashes.
 *
 * A frame with no eyes is returned as it is, by identity — four of the engine's poses
 * have no face at all, and they are among the ones a session spends the most time in.
 * @param frame - the frame to draw.
 * @param ring - the outline to draw the eyes with.
 * @returns the frame to hand the renderer.
 */
export function withRings(frame: BotFrame, ring: Ring): BotFrame {
  if (frame.eyes.length === 0) return frame
  return {
    ...frame,
    eyes: frame.eyes.map((eye) => {
      const box = eyeBox(eye.d)
      return { ...eye, d: ringPath(ring, box.w, box.h) }
    }),
  }
}
