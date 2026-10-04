/**
 * The face a pose wears: which outline its eyes are drawn with, and how the eyes
 * change outline when the pose does.
 *
 * Two tables, two jobs
 * --------------------
 * {@link EYE_FACES} is the outline each of the engine's poses wears when nothing else
 * is going on — the pose's own face, which is what makes a `burst` close its eyes and
 * an `orbit` narrow them. It is keyed by pose because that is what a pose means.
 *
 * What a *state* wears over the pose is `./pools.ts`'s business: a per-state pool, on
 * its own clock, so the long states stop being one expression (the module note there
 * has the whole argument, including why the earlier "the eyes need no schedule of
 * their own" was wrong). The two agree by construction — the first entry of every
 * pool is that state's {@link EYE_FACES} entry — so this file can keep saying "a state
 * opens its eyes when it arrives" while the pool says "and looks around while it
 * stays".
 *
 * The engine's own vocabulary for an eye is `EyeCfg { w, h, open, tilt }` — a capsule,
 * so a round eye, an oval eye, and a slitted eye are all it can say. The engine spends
 * that vocabulary well (see `./rings.ts` for what it does with it), and this table
 * only spends what it cannot: a lidded eye, and an eye closed into an arc.
 *
 * Why a face is one outline and not two
 * -------------------------------------
 * The engine hands the renderer a list of eyes with the ones behind the sphere already
 * dropped, and two facts are therefore lost: which eye is which, and whether one is
 * missing. A face that named an outline per eye would be applied to the wrong side the
 * first time the head turned far enough — a face is symmetric here because the frame
 * cannot support anything else. Asymmetry is the engine's, and it keeps it: `wink`'s
 * closed eye is its own box, four times wider and five times flatter than the open one.
 *
 * How the eyes change
 * -------------------
 * Over the destination pose's own `morph`, with the engine's own ease — the interval it
 * takes to morph its silhouette into that pose. So the eyes arrive with the body rather
 * than before or after it, and a pool rotation cannot make the face outrun the shape.
 * A reduced-motion companion arrives immediately, which is the rule `./poses.ts` applies
 * to a rotation, applied to the one thing about a rotation a reader would still see.
 *
 * The other half: a face the model asked for
 * ------------------------------------------
 * The model can ask for an expression by name through a tool, and the request reaches the
 * companion as a session fact (`activity.ts` → `signals.ts`). A request is **decoration**,
 * the same standing the pool rotation has, and it decides everything about how it is
 * treated here:
 *
 * - it **wins over the pose's own face** for as long as it holds, because a face that
 *   flickered back to the pose's between two pool rotations would not read as an
 *   expression at all;
 * - it **cannot move the state** — the ladder still decides which state is drawn, and the
 *   ladder is the thing the label and the accessible text are about, so the words can
 *   never end up describing a mood (`./poses.ts` makes the same argument for pools);
 * - a pose with **no face at all** keeps its body-level drawing, request or not: four of
 *   the engine's poses say what they mean with the body, and there is no eye to draw.
 *
 * A name nothing draws is ignored rather than refused here: the vocabulary is declared
 * for the model on the plugin side and mapped to outlines on this side, and a request for
 * a name this build does not know is a version skew rather than a crash. The test beside
 * `companion-eye-faces.client.spec.ts` keeps the two lists identical so it cannot happen
 * quietly.
 *
 * @module client/companion/eyes/faces
 */
import { easings, clamp } from '../engine/math.ts'
import { STATE_BY_ID, type StateId } from '../engine/states.ts'
import { RINGS, type Ring, type RingName } from './rings.ts'
import { lerpRing } from './interpolate.ts'
import { facePoolAt } from './pools.ts'

/**
 * The outline each pose draws its eyes with.
 *
 * Total over the engine's poses, so a pose added to the engine stops compiling here
 * until someone decides what its face looks like — the same property `./poses.ts` gets
 * from its own total table.
 *
 * Four poses list `open` because they have no face at all: `thinking` and `alert`,
 * `exclaim` and `sleep` all set `eyeAlpha: 0` and draw their meaning with the body (a
 * pulse, a bar and a dot, an exclamation, a "z"). They are listed anyway, because a
 * total table is what makes the omission a decision rather than a gap — and because a
 * missing entry would be a crash the first time a pool rotated into one.
 */
export const EYE_FACES: Readonly<Record<StateId, RingName>> = {
  /** The resting eyes, as the engine's capsules already were. */
  idle: 'open',
  /** No face: the body is three pulsing dots. */
  thinking: 'open',
  /** The wink's own asymmetry is the engine's box; a ring would only round it off. */
  wink: 'open',
  /** No face: the body is the "!". */
  exclaim: 'open',
  /** No face: the body is the "z". */
  sleep: 'open',
  /** No face: the body is a bar and a dot. */
  alert: 'open',

  /** Already the widest eye in the vocabulary: the box is the effect. */
  wide: 'open',
  /** The eyes a reader is asked to look at, so: round, like a ping. */
  notify: 'dot',
  /** Streaming: watching the words arrive. */
  comet: 'open',
  /** A run starting: neutral, because "started" is not yet "well". */
  play: 'open',

  /** Narrower, to match the narrower silhouette. */
  egg: 'oval',
  /** Round pupils inside a hexagon: the shape-change reads as play rather than as a face. */
  hexagon: 'dot',
  /** Tools in flight: the narrowed, tilted eye that means attention. */
  orbit: 'glint',
  /** Mid-change: the lid is already half down and will lift again. */
  swirl: 'half',
  /** Done: the eyes close into an arc, which is the one thing two capsules cannot say. */
  burst: 'beam',
}

/**
 * The expressions the model may ask for, by name, and the outline each one draws.
 *
 * Deliberately emotional names rather than outline names: a caller asks to look pleased,
 * not to be drawn as a crescent, and which crescent that is stays this side's business.
 * The names are also the tool's enum (the plugin declares them for the model), and a test
 * in this package reads that declaration and asserts the two lists are identical.
 *
 * Every entry names a shape from the outline table (`./rings.ts`), and no two entries share
 * one: a request can therefore only ask for a shape someone has looked at, and two names
 * never resolve to the same picture the way a table of synonyms would.
 */
export const EYE_EXPRESSIONS = {
  /** Nothing asked for: the resting eye. */
  neutral: 'open',
  /** Settled, unbothered. */
  calm: 'oval',
  /** Quietly satisfied, without a smile. */
  content: 'narrow',
  /** Nothing is interesting and the eye has stopped pretending otherwise. */
  bored: 'slim',
  /** Overwhelmed by scale: the eye opens all the way round. */
  awed: 'round',
  /** Taken aback. */
  surprised: 'dot',
  /** Startled in a way that shows in the size of the pupil. */
  flustered: 'bead',
  /** Alarmed to a pinprick. */
  overwhelmed: 'pin',
  /** Tired, or waiting. */
  sleepy: 'half',
  /** Worn down by a long stretch. */
  tired: 'tired',
  /** The eye settling after effort. */
  relaxed: 'droop',
  /** Attention kept up against sleep. */
  drowsy: 'hood',
  /** Effort with the lid nearly shut. */
  drained: 'heavy',
  /** The thinnest sliver of an eye: the end of a long night. */
  exhausted: 'slit',
  /** Pleased. */
  happy: 'smile',
  /** Something went well, and it shows. */
  delighted: 'beam',
  /** Amused rather than delighted. */
  amused: 'grin',
  /** A laugh that closes the eye. */
  laughing: 'laugh',
  /** Quiet pleasure. */
  pleased: 'arc',
  /** Effort, or a thing that did not work. */
  sad: 'frown',
  /** A setback, held. */
  disappointed: 'sad',
  /** A small, held disappointment. */
  upset: 'pout',
  /** Anger, which closes the eye the way a laugh does. */
  angry: 'glare',
  /** Attention in earnest: narrowed and tilted up. */
  focused: 'glint',
  /** Attention with a goal. */
  determined: 'keen',
  /** Effort rather than attention: the narrowed eye tilted the other way. */
  skeptical: 'squint',
  /** Suspicion rather than effort. */
  annoyed: 'leer',
  /** A glance rather than a stare. */
  shy: 'peek',
  /** Wariness, the lid doing the looking. */
  worried: 'slant',
  /** Something has been noticed. */
  curious: 'curious',
  /** Thinking about something just out of reach. */
  thoughtful: 'pensive',
  /** Raised away from the reader: distance, not attention. */
  distant: 'aloof',
} as const satisfies Readonly<Record<string, RingName>>

/** A name from {@link EYE_EXPRESSIONS}: what a caller may ask the companion to look like. */
export type ExpressionName = keyof typeof EYE_EXPRESSIONS

/**
 * Whether a string from outside is a name this build can draw.
 *
 * Ownership-prototype-safe on purpose: a request arrives as JSON from a transcript, so
 * `'constructor'` and `'toString'` are strings that get here, and a membership test
 * against the object rather than against its own keys would accept both.
 * @param value - any value a caller got hold of.
 * @returns whether it names an expression in the table.
 */
export function isExpressionName(value: unknown): value is ExpressionName {
  return typeof value === 'string'
    && Object.hasOwn(EYE_EXPRESSIONS, value)
}

/**
 * How long the eyes take to take up a pose's face, in milliseconds.
 *
 * The pose's own morph, read from the engine's table rather than declared: it is the
 * interval over which the engine morphs the silhouette into that pose, so the eyes and
 * the body they belong to finish together by construction.
 * @param pose - the pose whose face is arriving.
 * @returns the interval in milliseconds, never negative.
 */
export function faceMorphMs(pose: StateId): number {
  const definition = STATE_BY_ID.get(pose)
  /* v8 ignore next -- every pose a pool can name is a key of the engine's own table */
  if (definition === undefined) return 0
  return Math.max(0, definition.morph * 1000)
}

/**
 * The outline a state wears at this instant, unless an expression was asked for.
 *
 * One line, and it is the whole of the priority between the vocabularies: the state is a
 * session fact (through `./pools.ts`), the pose is the drawing under it, and a request is
 * decoration, so where they disagree the request is what is drawn. That it is one line is
 * the point — a second place that decided this would be a second answer, and the two
 * would disagree the first time a face expired mid-rotation.
 *
 * Keyed by **state**, not by pose, and that is the change a report about monotony bought:
 * a pose pool only varies the three busy states' bodies, while the face a waiting session
 * wears has to move on its own. Which pose is on screen is still what decides the *box* an
 * eye is drawn in and the interval it arrives over (`faceMorphMs`), so nothing about the
 * body is duplicated here.
 * @param state - the semantic state on screen, as the ladder decided it.
 * @param requested - the expression a caller asked for, if one is still holding.
 * @param nowMs - monotonic milliseconds, from the shared clock.
 * @param motion - whether animation is wanted; false wears the state's own face.
 * @returns the outline to draw.
 */
export function faceFor(state: StateId, requested: ExpressionName | undefined, nowMs: number, motion: boolean): RingName {
  return requested === undefined ? facePoolAt(state, nowMs, motion) : EYE_EXPRESSIONS[requested]
}

/**
 * The outline to draw the eyes with at this instant.
 *
 * Pure, and a function of the shared clock's elapsed time rather than of any instance's
 * history, so two seats showing one character cannot be caught morphing differently.
 * @param from - the outline the eyes are coming from, or `undefined` before the first one.
 * @param pose - the pose being drawn now, which is where a fresh face's interval comes from.
 * @param target - the outline the face is taking up, already resolved by {@link faceFor}.
 * @param elapsedMs - milliseconds since the outline last changed.
 * @param motion - whether animation is wanted; false arrives immediately.
 * @returns the outline, morphed by `elapsedMs`.
 */
export function faceRingAt(
  from: RingName | undefined,
  pose: StateId,
  target: RingName,
  elapsedMs: number,
  motion: boolean,
): Ring {
  const arrived = RINGS[target]
  // An outline that is not changing has nothing to interpolate, and `lerpRing` returns its
  // ends exactly, so coming from nowhere, coming from itself, and having elapsed past the
  // end are one case.
  if (from === undefined || from === target || !motion) return arrived
  return lerpRing(RINGS[from], arrived, easings.easeOutQuint(clamp(elapsedMs / faceMorphMs(pose))))
}
