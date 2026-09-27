// @vitest-environment jsdom
/**
 * The eye outlines, and the one thing that has to be true of all of them.
 *
 * These are geometry, so the tests are geometry: every ring is the same length, sits inside
 * the box its name claims, and is a **simple** closed curve.
 *
 * The last one is the interesting one, and it is worth saying what it is *not*. The
 * renderer punches an eye out of the body by painting each eye as its own black element
 * over a white silhouette, so a ring's **winding direction does not matter at all** — a
 * single closed subpath fills its interior either way under the default rule. What does
 * matter is that nothing crosses itself: a self-intersecting outline is exactly where the
 * nonzero rule starts filling holes, and one is a stroke of the generator away (a crescent
 * whose trailing arc bulges further than its leading one). So the assertion is that no two
 * non-adjacent segments meet.
 *
 * The generator is also asserted to be a generator: `crescent` bulges the way its
 * arguments say and `lidded` really is clipped at the level it was given, so a
 * change to either formula cannot quietly start drawing a different shape while the
 * names stay the same.
 */

import { describe, expect, it } from 'vitest'
import { RINGS, RING_SAMPLES, ringPath, type Ring } from '../src/client/companion/eyes/rings.ts'
import { lerpRing } from '../src/client/companion/eyes/interpolate.ts'
import type { Point } from '../src/client/companion/engine/shape.ts'

/** Every ring, by name, for the sweeps below. */
const ENTRIES = Object.entries(RINGS) as [keyof typeof RINGS, Ring][]

/**
 * Every consecutive pair of points, wrapping from the last one back to the first.
 *
 * The wrap is the point: a closed outline's last segment is the one a listed set of
 * points forgets, and it is where a shape that is secretly open shows up.
 * @param ring - the outline to walk.
 * @returns its segments, counted by the assertions beside them.
 */
function segments(ring: Ring): [Point, Point][] {
  const out: [Point, Point][] = []
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length]
    if (b !== undefined) out.push([a, b])
  })
  return out
}

/**
 * Which side of the line `p`→`q` the point `r` is on, or 0 when it is on it.
 * @param p - the line's start.
 * @param q - the line's end.
 * @param r - the point to place.
 * @returns the sign of the cross product.
 */
function side(p: Point, q: Point, r: Point): number {
  return Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x))
}

/**
 * Whether two segments cross, as opposed to touching.
 *
 * Strict on purpose: a shared end is what a closed outline is made of, and a point lying
 * *on* the other segment is a shape that touches itself rather than one that crosses.
 * @param a - first segment's start.
 * @param b - first segment's end.
 * @param c - second segment's start.
 * @param d - second segment's end.
 * @returns whether the two properly intersect.
 */
function crosses(a: Point, b: Point, c: Point, d: Point): boolean {
  const first = side(a, b, c)
  const second = side(a, b, d)
  const third = side(c, d, a)
  const fourth = side(c, d, b)
  return first !== 0 && second !== 0 && third !== 0 && fourth !== 0 && first !== second && third !== fourth
}

/** The extremes of one axis of a ring. */
function extent(ring: Ring, axis: 'x' | 'y'): { min: number; max: number } {
  const values = ring.map(p => p[axis])
  return { min: Math.min(...values), max: Math.max(...values) }
}

describe('every outline is the same kind of object', () => {
  it('is sampled at the shared length', () => {
    for (const [name, ring] of ENTRIES) {
      expect(ring, name).toHaveLength(RING_SAMPLES)
    }
  })

  it('stays inside the normalised box its name describes', () => {
    for (const [name, ring] of ENTRIES) {
      const x = extent(ring, 'x')
      const y = extent(ring, 'y')
      expect(x.min, `${name} min x`).toBeGreaterThanOrEqual(-1.0001)
      expect(x.max, `${name} max x`).toBeLessThanOrEqual(1.0001)
      expect(y.min, `${name} min y`).toBeGreaterThanOrEqual(-1.0001)
      expect(y.max, `${name} max y`).toBeLessThanOrEqual(1.0001)
    }
  })

  it('is not a degenerate blob: no zero-length segment and no duplicated end', () => {
    for (const [name, ring] of ENTRIES) {
      // Counted first, so the wrap is in and nothing was dropped on the way round: a
      // shape with a repeated end would be one segment short of a closed outline.
      const walked = segments(ring)
      expect(walked, `${name} segments`).toHaveLength(RING_SAMPLES)
      for (const [i, [a, b]] of walked.entries()) {
        expect(Math.hypot(b.x - a.x, b.y - a.y), `${name} segment ${i}`).toBeGreaterThan(1e-4)
      }
    }
  })

  it('is a simple closed curve: nothing crosses itself', () => {
    // What the mask needs of an outline (see the module note): an eye is drawn as its own
    // element, so its direction is irrelevant — but an outline that crossed itself would
    // start filling holes, and a crescent whose trailing arc bulged past its leading one
    // is one number away from doing exactly that.
    for (const [name, ring] of ENTRIES) {
      const walked = segments(ring)
      const crossings: string[] = []
      for (const [i, [a, b]] of walked.entries()) {
        for (const [j, [c, d]] of walked.entries()) {
          // Adjacent segments share an end, and so do the last and the first.
          if (j <= i + 1 || (i === 0 && j === walked.length - 1)) continue
          if (crosses(a, b, c, d)) crossings.push(`${i}×${j}`)
        }
      }
      expect(crossings, `${name} crossings`).toEqual([])
    }
  })
})

describe('the generators do what their arguments say', () => {
  it('bulges an arc toward -y, which is where a screen puts "up", with its ends on the line', () => {
    // The arc is the reason this module exists: an eye closed over something finished.
    // Up is -y in the engine's screen space, and both ends sit on `y0` — which is what
    // keeps it a closed shape rather than a stroke that needs a cap.
    const y = extent(RINGS.beam, 'y')
    expect(y.min).toBeLessThan(0)
    expect(y.max).toBeLessThanOrEqual(1e-6)
    // The ends, and the deepest point, are samples the parameterisation puts at exact
    // values — asserted by value rather than by index, and the deepest one being in the
    // middle is what separates an arc from a tilted line.
    expect(RINGS.beam).toContainEqual({ x: -1, y: 0 })
    expect(RINGS.beam).toContainEqual({ x: 1, y: 0 })
    expect(RINGS.beam).toContainEqual({ x: 0, y: -0.78 })
  })

  it('clips a lidded eye at its level and keeps the rest of the shape', () => {
    const level = -0.02
    for (const point of RINGS.half) {
      expect(point.y, 'half point').toBeGreaterThanOrEqual(level - 1e-6)
    }
    // It is still a shape and not a half-disc: the chord is at the level, and the
    // outline reaches the bottom of the box.
    expect(extent(RINGS.half, 'y').max).toBeGreaterThan(0.9)
  })

  it('tilts an eye about its own centre rather than moving it', () => {
    // The tilt changes the box the shape occupies without translating it, which is
    // what makes it usable under the engine's own tangent matrix. `glint` is an
    // ellipse of half-width 0.34 and half-height 0.95 turned 22 degrees, and the
    // support of a rotated ellipse in x is `hypot(a cos phi, b sin phi)` — so the
    // expected width is arithmetic, not whatever the generator happens to produce.
    const phi = (22 * Math.PI) / 180
    const support = Math.hypot(0.34 * Math.cos(phi), 0.95 * Math.sin(phi))
    expect(extent(RINGS.glint, 'x').max).toBeCloseTo(support, 2)
    // Wider than the same ellipse untilted (0.34) is the whole visible effect, and it
    // is still the long axis that fills the box, so the tilt cannot have swapped them.
    expect(extent(RINGS.glint, 'x').max).toBeGreaterThan(0.34)
    expect(extent(RINGS.glint, 'y').max).toBeCloseTo(Math.hypot(0.34 * Math.sin(phi), 0.95 * Math.cos(phi)), 2)
    // Centred: the samples average to the origin, so nothing was slid sideways.
    const mean = RINGS.glint.reduce(
      (acc, p) => ({ x: acc.x + p.x / RING_SAMPLES, y: acc.y + p.y / RING_SAMPLES }),
      { x: 0, y: 0 },
    )
    expect(mean.x).toBeCloseTo(0, 6)
    expect(mean.y).toBeCloseTo(0, 6)
  })
})

describe('a ring becomes a path in the space an eye is drawn in', () => {
  it('writes a closed path with one curve per sample', () => {
    const d = ringPath(RINGS.open, 60, 120)
    expect(d.startsWith('M')).toBe(true)
    expect(d.endsWith('Z')).toBe(true)
    // The start is written once and then one curve per sample, the last of which lands
    // back on the start. Counted rather than split, because `closedPath` puts the move
    // in front: a short path means a ring lost points somewhere.
    expect(d.match(/C/gu)).toHaveLength(RING_SAMPLES)
  })

  it('scales the outline to the eye box, half-extent by half-extent', () => {
    // A hand-built ring, so the expected coordinates are arithmetic rather than
    // whatever the generators happen to produce: a unit square in the box becomes a
    // rectangle of w by h about the origin.
    const square: Ring = [
      { x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 },
    ]
    const d = ringPath(square, 60, 120)
    // Corners at (∓30, ∓60): the first point is written exactly, and the rest follow
    // from the same arithmetic.
    expect(d.startsWith('M-30 -60')).toBe(true)
    expect(d).toContain('30 -60')
    expect(d).toContain('30 60')
    expect(d).toContain('-30 60')
    // A real ring fills the box and does not wander out of it. Asserted on a sampled
    // ring and not on the square above: `closedPath` estimates each tangent from the
    // neighbouring points, so the corner of a four-point square genuinely overshoots,
    // while a ring sampled at RING_SAMPLES points stays within a rounding error. That
    // discrepancy is the reason the outlines are sampled at all.
    const numbers = (ringPath(RINGS.open, 60, 120).match(/-?\d+(\.\d+)?/gu) ?? []).map(Number)
    expect(numbers.length).toBeGreaterThan(RING_SAMPLES)
    expect(Math.max(...numbers.map(Math.abs))).toBeLessThanOrEqual(60.01)
  })

  it('produces a different path for every name, so no two rings are secretly one shape', () => {
    const paths = ENTRIES.map(([name, ring]) => `${name}:${ringPath(ring, 60, 120)}`)
    expect(new Set(paths).size).toBe(ENTRIES.length)
  })
})

describe('interpolating two outlines', () => {
  it('returns the ends exactly at the ends, for every pair of outlines', () => {
    // Exact, not close: a morph is driven by a ratio that lands on one and stays there,
    // and a face that settled a fraction of a unit off its own outline would keep it
    // forever. Asserted over the whole table rather than on one pair, because whether
    // `a + (b - a) * 1` differs from `b` depends on the two numbers — one pair passing
    // would say nothing about the rest.
    for (const [name, ring] of ENTRIES) {
      for (const [target, other] of ENTRIES) {
        expect(lerpRing(ring, other, 0), `${name} at 0`).toStrictEqual(ring)
        expect(lerpRing(ring, other, 1), `${name} to ${target}`).toStrictEqual(other)
        // Past an end as well as short of it: an overshooting caller gets the end shape
        // rather than a reflection of it or an extrapolation away from the body.
        expect(lerpRing(ring, other, -5), `${name} below 0`).toStrictEqual(ring)
        expect(lerpRing(ring, other, 5), `${name} past ${target}`).toStrictEqual(other)
      }
    }
  })

  it('stays in the box the two ends describe, at every step between them', () => {
    // A morph must not overshoot: an eye that pokes out of the body is exactly the
    // artefact the engine's own fit table exists to prevent, and a linear blend
    // between two in-bounds shapes is in bounds by construction — asserted so a
    // future easing that overshoots is caught here rather than on screen.
    for (const t of [0, 0.13, 0.5, 0.87, 1]) {
      const ring = lerpRing(RINGS.open, RINGS.half, t)
      for (const point of ring) {
        expect(Math.abs(point.x)).toBeLessThanOrEqual(1.0001)
        expect(Math.abs(point.y)).toBeLessThanOrEqual(1.0001)
      }
    }
  })

  it('is the midpoint at a half, point for point', () => {
    const ring = lerpRing(RINGS.open, RINGS.dot, 0.5)
    expect(ring).toHaveLength(RING_SAMPLES)
    // Every point, not just the first: an interpolator that mirrored its index would
    // still be right at point 0 on this pair.
    ring.forEach((p, i) => {
      const a = RINGS.open[i]
      const b = RINGS.dot[i]
      if (a === undefined || b === undefined) return
      expect(p.x, `point ${i} x`).toBeCloseTo((a.x + b.x) / 2, 10)
      expect(p.y, `point ${i} y`).toBeCloseTo((a.y + b.y) / 2, 10)
    })
  })
})
