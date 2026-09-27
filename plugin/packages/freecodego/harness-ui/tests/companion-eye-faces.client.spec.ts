// @vitest-environment jsdom
/**
 * Which outline a pose wears, how long it takes to change, and the seam that puts it
 * into a frame.
 *
 * Two halves, and they fail differently. The face table is data, so what can go wrong
 * with it is coverage: a pose with no face, or a name that is not an outline. The seam
 * is the one place this package reads something back out of the engine — the box an eye
 * was drawn at — so its test is the one that has to be arithmetic rather than a smoke
 * test: a grid of boxes, and then every eye the engine's own pose table can produce.
 *
 * The frame half is asserted on a frame the real engine produced, not on a hand-written
 * object, because the property worth having is exactly that this works on the eyes the
 * engine actually emits — with their own matrices, their own depths, and the ones it
 * drops behind the sphere.
 */

import { describe, expect, it } from 'vitest'
import { BotEngine } from '../src/client/companion/engine/engine.ts'
import { RAYON } from '../src/client/companion/engine/repere.ts'
import { capsulePath } from '../src/client/companion/engine/shape.ts'
import { STATE_BY_ID, STATES } from '../src/client/companion/engine/states.ts'
import { eyeBox, withRings } from '../src/client/companion/eyes/apply.ts'
import {
  EYE_EXPRESSIONS,
  EYE_FACES,
  faceFor,
  faceMorphMs,
  faceRingAt,
  isExpressionName,
  type ExpressionName,
} from '../src/client/companion/eyes/faces.ts'
import { RING_SAMPLES, RINGS, ringPath, type RingName } from '../src/client/companion/eyes/rings.ts'

/** Every pose the engine has, by id. */
const POSES = STATES.map(state => state.id)

/** The engine a seat builds, for frames produced by the real thing. */
function engineAt(pose: (typeof POSES)[number], seconds: number) {
  const engine = new BotEngine(RAYON, 'idle')
  engine.reset(pose, 0)
  return engine.sample(seconds)
}

describe('the face a pose wears', () => {
  it('names an outline for every pose the engine has, and for nothing else', () => {
    expect(Object.keys(EYE_FACES).sort()).toStrictEqual([...POSES].sort())
  })

  it('moves from the outline it had to the one it is taking up', () => {
    const from = RINGS[EYE_FACES.idle]
    const to = RINGS[EYE_FACES.burst]
    expect(from).not.toStrictEqual(to)
    expect(faceRingAt(EYE_FACES.idle, 'burst', EYE_FACES.burst, 0, true)).toStrictEqual(from)
    const middle = faceRingAt(EYE_FACES.idle, 'burst', EYE_FACES.burst, faceMorphMs('burst') / 2, true)
    // Between the two, point for point: an in-between outline is not one of the ends,
    // and every point of it sits on the segment between the two ends' points.
    expect(middle).not.toStrictEqual(from)
    expect(middle).not.toStrictEqual(to)
    expect(middle).toHaveLength(RING_SAMPLES)
    middle.forEach((p, i) => {
      const a = from[i]
      const b = to[i]
      if (a === undefined || b === undefined) return
      expect(p.x, `point ${i}`).toBeGreaterThanOrEqual(Math.min(a.x, b.x) - 1e-9)
      expect(p.x, `point ${i}`).toBeLessThanOrEqual(Math.max(a.x, b.x) + 1e-9)
      expect(p.y, `point ${i}`).toBeGreaterThanOrEqual(Math.min(a.y, b.y) - 1e-9)
      expect(p.y, `point ${i}`).toBeLessThanOrEqual(Math.max(a.y, b.y) + 1e-9)
    })
  })

  it('arrives with the body, over the destination pose\'s own morph', () => {
    // The interval is the engine's, so a pool rotation cannot make the face outrun the
    // silhouette it belongs to. Asserted over every pose, and at the boundary rather
    // than past it: what a seat samples is a time that keeps arriving.
    for (const pose of POSES) {
      const definition = STATE_BY_ID.get(pose)!
      expect(faceMorphMs(pose), pose).toBe(definition.morph * 1000)
      const arrived = RINGS[EYE_FACES[pose]]
      expect(faceRingAt(EYE_FACES.idle, pose, EYE_FACES[pose], faceMorphMs(pose), true), pose).toStrictEqual(arrived)
      expect(faceRingAt(EYE_FACES.idle, pose, EYE_FACES[pose], faceMorphMs(pose) * 4, true), pose).toStrictEqual(arrived)
      // A pose morphing into itself has nothing to interpolate, and a pose that has no
      // predecessor arrives at its own face rather than passing through `idle`'s.
      expect(faceRingAt(EYE_FACES[pose], pose, EYE_FACES[pose], 0, true), pose).toStrictEqual(arrived)
      expect(faceRingAt(undefined, pose, EYE_FACES[pose], 0, true), pose).toStrictEqual(arrived)
    }
  })

  it('arrives immediately when motion is not wanted', () => {
    // The gate lives here, at the instant the outline is chosen, and not at the seat:
    // a frozen seat redraws only when the words change, so a gate that a seat could
    // forget would be hidden by that short-circuit instead of showing up as a moving
    // picture.
    expect(faceRingAt(EYE_FACES.idle, 'burst', EYE_FACES.burst, 0, false)).toStrictEqual(RINGS[EYE_FACES.burst])
    expect(faceRingAt(EYE_FACES.orbit, 'idle', EYE_FACES.idle, 0, false)).toStrictEqual(RINGS[EYE_FACES.idle])
    // An expression asked for while the session is frozen is the one thing a frozen
    // companion *can* still show, since it is a face and not a rotation.
    expect(faceRingAt(EYE_FACES.idle, 'idle', 'smile', 0, false)).toStrictEqual(RINGS.smile)
  })

  it('wears the expression it was asked for over the state\'s own face', () => {
    // The whole of the priority between the vocabularies: while a request holds, the state
    // and its pool contribute the interval and nothing else. Asserted at three clock times
    // because without a request the pool would answer differently at each of them — which
    // is exactly what a request must suppress.
    for (const [name, outline] of Object.entries(EYE_EXPRESSIONS) as [ExpressionName, RingName][]) {
      for (const nowMs of [0, 1_700, 9_000]) expect(faceFor('idle', name, nowMs, true), `${name} at ${nowMs}`).toBe(outline)
      expect(faceRingAt(EYE_FACES.idle, 'burst', outline, faceMorphMs('burst'), true), name)
        .toStrictEqual(RINGS[outline])
      // And the moment the request is history the state's own face is what is drawn,
      // which is the same call with nothing asked for.
      expect(faceFor('burst', undefined, 0, true), name).toBe(EYE_FACES.burst)
    }
  })

  it('names a different outline for every expression, and only outlines something draws', () => {
    const outlines = Object.values(EYE_EXPRESSIONS)
    // Two names for one shape is a vocabulary lie: the caller cannot see the difference
    // it was offered.
    expect(new Set(outlines).size).toBe(outlines.length)
    // And every expression is an outline from the vocabulary the poses already use, so a
    // request can only ask for a shape someone has looked at.
    for (const outline of outlines) expect(RINGS[outline], outline).toBeDefined()
  })

  it('takes a name from outside only when it names an expression', () => {
    for (const name of Object.keys(EYE_EXPRESSIONS)) expect(isExpressionName(name), name).toBe(true)
    // The interesting cases: a request is read out of a transcript, so the strings that
    // are on every object get here. A membership test against the table's prototype
    // chain — `in`, or a bare truthy lookup — would accept both of the first two.
    expect(isExpressionName('constructor')).toBe(false)
    expect(isExpressionName('toString')).toBe(false)
    expect(isExpressionName('')).toBe(false)
    expect(isExpressionName(undefined)).toBe(false)
    expect(isExpressionName(3)).toBe(false)
    expect(isExpressionName({ face: 'happy' })).toBe(false)
  })
})

describe('the box an eye was drawn at', () => {
  it('reads back the capsule the engine wrote, over a grid of boxes', () => {
    // Including the engine's own smallest eye (`egg`) and its widest (`notify`), and
    // boxes whose halves do not land on two decimals, where `r2` rounds.
    const boxes = [
      [0.186, 0.412], [0.164, 0.385], [0.505, 0.498], [0.356, 0.875],
      [1, 1], [33.3, 7.7], [0.01, 0.01], [12.345, 67.891],
    ] as const
    for (const [w, h] of boxes) {
      const box = eyeBox(capsulePath(w * RAYON, h * RAYON))
      // `capsulePath` rounds to two decimals, so the box comes back within one of them.
      expect(box.w, `${w}x${h} width`).toBeCloseTo(w * RAYON, 1)
      expect(box.h, `${w}x${h} height`).toBeCloseTo(h * RAYON, 1)
    }
  })

  it('finds a box for every eye the engine\'s pose table can produce', () => {
    // The property that has to hold for the seam to be safe: wherever the engine draws
    // an eye — including a pose whose box is a function of time, and the two that are
    // wider than they are tall — the capsule states its own box.
    for (const pose of POSES) {
      const definition = STATE_BY_ID.get(pose)!
      for (const local of [0, 0.35, 1, 2.5]) {
        for (const eye of definition.pose(local).eyes) {
          const box = eyeBox(capsulePath(eye.w * RAYON, eye.h * RAYON))
          expect(box.w, `${pose} at ${local}s`).toBeGreaterThan(0)
          expect(box.h, `${pose} at ${local}s`).toBeGreaterThan(0)
        }
      }
    }
  })
})

describe('drawing a ring where the engine drew a capsule', () => {
  it('draws the outline at the box the engine chose, and leaves the placement alone', () => {
    const frame = engineAt('idle', 0)
    expect(frame.eyes.length).toBeGreaterThan(0)
    const ring = RINGS[EYE_FACES.burst]
    const drawn = withRings(frame, ring)
    expect(drawn.eyes).toHaveLength(frame.eyes.length)
    frame.eyes.forEach((eye, at) => {
      const after = drawn.eyes[at]
      expect(after, `eye ${at}`).toBeDefined()
      if (after === undefined) return
      const box = eyeBox(eye.d)
      expect(after.d).toBe(ringPath(ring, box.w, box.h))
      // Placement is the engine's: the same matrix, the same depth, the same opacity.
      expect(after.matrix).toBe(eye.matrix)
      expect(after.alpha).toBe(eye.alpha)
      // And the drawn eye is a curve rather than a capsule — the shapes are not merely
      // different strings, they are different kinds of path.
      expect(after.d.match(/C/gu)).toHaveLength(RING_SAMPLES)
      expect(eye.d).toContain('A')
    })
    // Nothing else about the frame moves.
    expect(drawn.bodyPath).toBe(frame.bodyPath)
    expect(drawn.bodyAlpha).toBe(frame.bodyAlpha)
    expect(drawn.dots).toStrictEqual(frame.dots)
    expect(drawn.arcs).toStrictEqual(frame.arcs)
    expect(drawn.notif).toStrictEqual(frame.notif)
  })

  it('hands back a faceless frame as it is', () => {
    // Four of the engine's poses draw their meaning with the body and set `eyeAlpha: 0`,
    // so there are no eyes to re-draw — asserted by identity, because a frame that is
    // rebuilt every tick for nothing is a frame that churns every seat.
    const frame = engineAt('thinking', 1)
    expect(frame.eyes).toStrictEqual([])
    expect(withRings(frame, RINGS.open)).toBe(frame)
  })
})
