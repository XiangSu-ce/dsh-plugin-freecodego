/**
 * The companion's eye outlines: closed shapes a state can draw its eyes with.
 *
 * Why this exists
 * --------------
 * The engine already places eyes well. `face.ts` puts each eye on a real sphere
 * (a yaw/pitch/roll head orientation, tangent frame per eye, orthographic
 * projection, a `depth` that hides the far side), and the constants are fitted to
 * the reference footage to about a pixel of residual. `liveliness` adds a gaze
 * drift whose periods are coprime so the motion never visibly repeats, plus a blink
 * schedule drawn once and replayed deterministically, and `blinkScale` squashes the
 * eye vertically *in screen space* because that is what was measured.
 *
 * None of that is rebuilt here. What the engine cannot do is give an eye a **shape
 * other than its capsule**: `EyeCfg` is `{ w, h, open, tilt }`, so the vocabulary
 * is round, oval, and slitted, all of them symmetric about their own centre. A
 * crescent — the shape a closed happy eye makes, and the reason a face reads as
 * *delighted* rather than merely *attentive* — is not expressible at all, and
 * neither is a lid that has come down over the top of the eye.
 *
 * So this module is data, and only data: outlines, and the one function that turns
 * one into a path in the same local space `capsulePath` writes in. Everything the
 * engine does to an eye — where it sits on the sphere, how far it has blinked, how
 * much of its depth is facing the reader, and the per-shape offset table `eyefit`
 * solves so a capsule never pokes out of a narrow silhouette — keeps applying,
 * because the renderer only ever needed a path and a matrix.
 *
 * The space a ring is written in
 * -----------------------------
 * `x ∈ [-1, 1]` is the eye's full width and `y ∈ [-1, 1]` its full height, with `y`
 * the **long** axis — the engine's own convention (`EYE_W` 0.186 against `EYE_H`
 * 0.412), where the resting eye is a tall vertical shape and a blink squashes it
 * downward. So `ellipse(1, 1)` is the whole eye box, `ellipse(1, 0.1)` is a closed
 * eye, and a crescent bulging toward `-y` is the upward arc a smile makes on a
 * screen whose `y` points down.
 *
 * The box itself is not this module's business: an outline is normalised, and the
 * caller scales it to the eye the engine drew (`./apply.ts`). That is what keeps the
 * outlines independent of a pose — the engine's own eye boxes differ by a factor of
 * four between `egg` and `notify`.
 *
 * Why the shapes are generated rather than listed
 * ----------------------------------------------
 * Each outline is produced by sampling a formula at {@link RING_SAMPLES} angles, so
 * two rings always have the same number of points in the same order and can be
 * interpolated point by point (`./interpolate.ts`). It also means a shape's
 * properties are assertable rather than eyeballed: closed, in bounds, and monotone
 * under a scale.
 *
 * @module client/companion/eyes/rings
 */
import { closedPath, type Point } from '../engine/shape.ts'

/**
 * Points per ring.
 *
 * Forty-eight, which is what the source material's outlines use, and comfortably
 * more than a closed Catmull-Rom curve needs to look smooth: `closedPath`'s own
 * note says sixty-four points is "smooth to the pixel" drawn at 600 px, and the
 * companion is drawn between 28 and 64.
 */
export const RING_SAMPLES = 48

/**
 * One closed outline, sampled counter-clockwise from the right, in the normalised
 * box described in the module note.
 */
export type Ring = readonly Point[]

/** Sample a closed outline at {@link RING_SAMPLES} evenly spaced parameters. */
function sample(at: (t: number) => Point): Ring {
  const out: Point[] = []
  for (let i = 0; i < RING_SAMPLES; i++) out.push(at(i / RING_SAMPLES))
  return out
}

/** An ellipse filling the given fraction of the box. */
function ellipse(sx: number, sy: number): Ring {
  return sample((t) => {
    const angle = t * Math.PI * 2
    return { x: Math.cos(angle) * sx, y: Math.sin(angle) * sy }
  })
}

/**
 * A crescent: an arc of sagitta `rise`, closed by a second arc `thickness` behind it.
 *
 * Both arcs meet at the ends of the shape, so the outline is closed by construction
 * rather than by a chord. A positive `rise` bulges toward `-y`, which is up on a
 * screen — the arc a laughing eye makes; a negative one is the same shape the other
 * way up.
 *
 * **`thickness` is measured the same way round as `rise`**, so a downward arc passes
 * both numbers negative ({@link RINGS.frown}). A thickness that stayed positive under a
 * negative rise would trail *further* than it leads and come out inside out.
 * @param rise - how far the leading arc bulges, in box units.
 * @param thickness - the shape's widest measured thickness, in box units, carrying the
 * sign of `rise`.
 * @param y0 - where the two ends sit, in box units.
 * @returns the outline.
 */
function crescent(rise: number, thickness: number, y0 = 0): Ring {
  return sample((t) => {
    const leading = t < 0.5
    // One sweep along the leading arc, one back along the trailing one. The two halves
    // advance in x in opposite directions, which is what keeps *point `i`* comparable
    // between two crescents: a morph from an upward arc to a downward one is then a
    // vertical flip through a flat line rather than a twist around the ring.
    const u = leading ? t * 2 : (1 - t) * 2
    const x = u * 2 - 1
    const sag = 1 - x * x
    return { x, y: y0 - (leading ? rise : rise - thickness) * sag }
  })
}

/**
 * A lidded eye: the part of the eye box below a lid line.
 *
 * The lid is a straight chord, which is what a lid at rest is — and it is the shape
 * the engine cannot make, because `open` scales a capsule's height about its own
 * centre instead of hiding its top. The chord closes the outline exactly through the
 * two points where the lid crosses the eye.
 * @param level - the lid's height in box units, negative being above centre.
 * @returns the outline.
 */
function lidded(level: number): Ring {
  const edge = Math.asin(Math.max(-0.999, Math.min(0.999, level)))
  const span = Math.PI - 2 * edge
  const rightX = Math.cos(edge)
  const leftX = Math.cos(edge + span)
  return sample((t) => {
    if (t < 0.5) {
      const angle = edge + t * 2 * span
      return { x: Math.cos(angle), y: Math.sin(angle) }
    }
    const u = (t - 0.5) * 2
    return { x: leftX + (rightX - leftX) * u, y: level }
  })
}

/** The same outline, tilted about its own centre. */
function tilted(ring: Ring, degrees: number): Ring {
  const phi = (degrees * Math.PI) / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  return ring.map(p => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos }))
}

/**
 * The same outline, moved along the box's long axis.
 *
 * A gaze is an *offset*, not a shape, and the engine's own eyes have one — but its
 * `liveliness` drift moves both eyes together over a sphere, which is where a face looks
 * rather than what its eye is doing. A ring that sits high in its box says the same thing
 * without the head turning, which is what a face needs when it is the *only* thing on
 * screen at eight pixels tall. `dy` is negative upwards, as everywhere in this engine.
 * @param ring - the outline to move.
 * @param dy - how far along the long axis, in box units.
 * @returns the outline.
 */
function shifted(ring: Ring, dy: number): Ring {
  return ring.map(p => ({ x: p.x, y: p.y + dy }))
}

/**
 * Every outline, by name.
 *
 * The names are the vocabulary a pose's face is written in (`./faces.ts`), so a face
 * that names one that does not exist fails to compile — the same property the locale
 * dictionary gets by keying itself on the engine's state ids.
 *
 * The list is exactly the vocabulary the character uses, not a catalogue: every name
 * here is drawn by at least one pose, by one expression the model can ask for, or by one
 * entry of a state's face pool (`./pools.ts`), and a shape nothing draws is a shape nobody
 * has looked at. Adding one is a data edit in this table plus the face that names it
 * (`./faces.ts` names both kinds).
 *
 * The interesting entries are the arcs and the lidded pair — an eye closed into a curve and
 * an eye with a lid over it are what two capsules genuinely cannot say, which is why this
 * module exists — and the tilted and shifted families, the only shapes here whose meaning is
 * a *direction* or an *offset* rather than a contour. Most names are reached from exactly
 * one place (`./faces.ts` maps a caller's name onto one of them), while a few are also
 * walked by a state's pool (`./pools.ts`). A shape nothing draws would be a shape nobody has
 * looked at, and the spec beside this module enforces that every name here is worn.
 */
export const RINGS = {
  /** The whole box: the resting eye, and the closest thing to the engine's capsule. */
  open: ellipse(1, 1),
  /** Narrower than the box, for the flourishes whose own silhouette is already narrow. */
  oval: ellipse(0.72, 1),
  /** Narrower still: an eye that is paying attention without being startled. */
  narrow: ellipse(0.46, 1),
  /** The narrowest upright eye: mostly shut with intention rather than sleep. */
  slim: ellipse(0.28, 1),
  /** A round eye that fills both axes: wonder rather than attention. */
  round: ellipse(0.78, 0.78),
  /** A round pupil, for a face that has just been pinged. */
  dot: ellipse(0.5, 0.42),
  /** A small pupil sitting wide: something small and startling was noticed. */
  bead: ellipse(0.34, 0.5),
  /** The smallest eye in the vocabulary: a pinprick of alarm. */
  pin: ellipse(0.22, 0.32),
  /** Lidded at the middle, the way a face mid-change looks. */
  half: lidded(-0.02),
  /**
   * Lidded low: the thin sliver of an eye that is mostly closed, which is what waiting a
   * long time looks like on a face. Lower than `half` on purpose — the two are the same
   * generator at two levels, and the difference between "mid-blink" and "tired" *is* the
   * level, so a second shape here would be a second measurement of the same idea.
   */
  tired: lidded(0.38),
  /** A lid a little lower than `half`: the eye settling rather than arriving. */
  droop: lidded(0.22),
  /** A lid past the middle: attention kept up against the pull of sleep. */
  hood: lidded(0.5),
  /** A lid low enough that the eye is effort rather than sight. */
  heavy: lidded(0.6),
  /** The thin sliver that is almost shut: the end of a long wait, or a long night. */
  slit: lidded(0.78),
  /**
   * A soft upward arc: the eye of a face that is pleased rather than delighted.
   *
   * The arcs are thick enough to survive the size they are drawn at, and that is not a
   * detail. The companion's eye is about eight pixels tall on the strip and five on the
   * rail, so a shape's own thickness becomes a fraction of a pixel: a crescent a third as
   * thick as its rise is a hairline on the rail and an anti-aliased smudge rather than an
   * eye. Slightly over half the rise is what a closed eye looks like drawn as a solid.
   */
  smile: crescent(0.55, 0.3),
  /** A deep upward arc: the eye a face closes over something it finished. */
  beam: crescent(0.78, 0.4),
  /** A shallow upward arc: amusement rather than delight. */
  grin: crescent(0.38, 0.24),
  /** The deepest arc in the vocabulary: a laugh that closes the eye. */
  laugh: crescent(0.95, 0.55),
  /** A broad, calm upward arc: quiet pleasure. */
  arc: crescent(0.62, 0.45),
  /** The same arc turned down: effort, disappointment, a thing gone wrong. */
  frown: crescent(-0.45, -0.24),
  /** A deeper downward arc: grief rather than a setback. */
  sad: crescent(-0.62, -0.34),
  /** A shallow downward arc: a small, held disappointment. */
  pout: crescent(-0.32, -0.2),
  /** The deepest downward arc: anger, which closes the eye the way a laugh does. */
  glare: crescent(-0.85, -0.5),
  /** A narrow eye tilted up toward the nose: attention in earnest. */
  glint: tilted(ellipse(0.34, 0.95), 22),
  /**
   * The same narrowed eye tilted the other way: effort rather than attention. The mirror of
   * `glint` rather than a new shape, because at this size the direction of the tilt is the
   * whole of what a reader can tell — and a pair that is exactly mirrored is the one pair
   * that cannot drift into looking like each other.
   */
  squint: tilted(ellipse(0.36, 0.9), -20),
  /** A sharper tilt than `glint`: attention with a goal. */
  keen: tilted(ellipse(0.3, 0.85), 30),
  /** A sharper tilt the other way than `squint`: suspicion rather than effort. */
  leer: tilted(ellipse(0.32, 0.88), -30),
  /** A gentle tilt of a tall eye: a glance rather than a stare. */
  peek: tilted(ellipse(0.4, 0.95), 14),
  /** A lidded eye leaned over: wariness, the lid doing the looking. */
  slant: tilted(lidded(0.1), 18),
  /**
   * A wide eye sitting high in its box: something has been noticed.
   *
   * The meaning is an *offset* (`shifted`) rather than a contour, and that is deliberately
   * the only way this vocabulary says "looking at" — the engine moves both eyes over a
   * sphere and does it properly, so a ring only ever raises the pupil inside its own box.
   * It stays in bounds: half-height 0.62 lifted 0.28 leaves 0.9 of the box above it, so the
   * shape cannot poke out of the silhouette the fit table protects.
   */
  curious: shifted(ellipse(0.75, 0.62), -0.28),
  /** The same eye lowered: a face thinking about something just out of reach. */
  pensive: shifted(ellipse(0.6, 0.55), 0.3),
  /** A calm eye raised away from the reader: distance, not attention. */
  aloof: shifted(ellipse(0.55, 0.5), -0.34),
} as const

/** A name from {@link RINGS}. */
export type RingName = keyof typeof RINGS

/**
 * One ring as an SVG path, in the local space an eye is drawn in.
 *
 * `capsulePath(w, h)` writes a capsule spanning the same box, so a ring and a capsule
 * are interchangeable as an eye's `d` and the engine's placement, blink and depth
 * keep applying to either. The curve is the engine's own `closedPath`, which is the
 * same Catmull-Rom the body silhouette uses — one curve implementation, not two.
 * @param ring - the outline to draw.
 * @param w - the eye's width in viewBox units, as `EyeCfg.w * RAYON`.
 * @param h - the eye's height in viewBox units, as `EyeCfg.h * RAYON`.
 * @returns the path.
 */
export function ringPath(ring: Ring, w: number, h: number): string {
  return closedPath(ring.map(p => ({ x: (p.x * w) / 2, y: (p.y * h) / 2 })))
}
