/**
 * The faces a state may be drawn with, and the schedule that walks them.
 *
 * Why the eyes get a schedule of their own
 * ---------------------------------------
 * `./faces.ts` used to argue the opposite, and the argument was sound for what it
 * described: the eyes are a property of the pose, and a pose pool already walks
 * `thinking → egg → wide → hexagon`, so a second clock could only ever disagree
 * with the body it sits in. What that missed is *how much of the picture the pose
 * pool actually owns*. It varies the body for the three long busy states, and the
 * state a user spends the most time looking at — the resting floor, `idle`, where a
 * session waits for input — is a one-pose pool. So the face the reader saw while
 * waiting was one expression, indefinitely, and the report was exact: 思考中 was the
 * same three dots for a minute, and 空闲 was the same pair of eyes for as long as
 * the window stayed open.
 *
 * A **face pool** is per semantic state and holds only outlines that state may wear
 * without arguing with its words. The body still belongs to the pose pool; this
 * varies the eyes over it. Both are drawings, and neither can move the state — which
 * stays the ladder's, and stays what the label and the accessible text are about.
 *
 * Which states rotate
 * -------------------
 * The ones a session sits in: `idle` (waiting), and the busy trio
 * (`thinking`/`orbit`/`comet`). Everything else is a one-entry pool, which is the
 * degenerate case rather than a missing entry — a total table means a state added to
 * the engine stops compiling here until someone decides, and `burst` ("Done") and the
 * faceless poses keep exactly the face they had.
 *
 * The first entry of each pool is the state's own face (`./faces.ts`'s `EYE_FACES`),
 * which is the invariant that makes this a widening rather than a rewrite: the
 * outline a state is most itself with is still the one it starts on, and a pool that
 * forgot it would be a state whose face changed meaning.
 *
 * The three rotating pools are longer than the resting one, and that is the same
 * statement the two intervals make in the other currency: variety. A working session is
 * allowed to reach shapes the resting face never wears (`curious`, `squint`), because
 * there is something to be curious *about* — the pool tables are where that judgement is
 * written down rather than inferred from a constant.
 *
 * Why the schedule is a function of the clock
 * ------------------------------------------
 * Three seats draw one character, and the clock is the one thing they share exactly
 * — the same property `../poses.ts` gets by stepping its pools from `nowMs` rather
 * than from a counter. The *order* inside the pool is pseudo-random but equally
 * deterministic: a hash of the state's name and the cycle index, so it looks arbitrary
 * while two seats at one instant still draw one face.
 *
 * The order is built as a **rotation per cycle** rather than as an independent draw per
 * step, because the one rule the schedule must respect is that an outline never follows
 * itself — and a hash per step gets that wrong roughly once in `length` steps, which is
 * exactly often enough to read as a stuck face. A cycle walks every entry once (so no
 * repeats inside it) from a hash-chosen start, and the only step that can collide with
 * its predecessor across cycles is the first one, which is checked and nudged back. That
 * is O(1) and needs no memory of what was drawn, which is what keeps the answer a pure
 * function of the clock.
 *
 * Randomness is what keeps the rotation from reading as a loop; the rotation is what
 * makes it impossible to see the same face twice in a row.
 *
 * The interval is shorter for the busy states than for the resting one on purpose: a
 * working session changing its eyes every second and a half reads as effort, while a
 * waiting one doing that reads as a twitch. `RESTING_FACE_INTERVAL_MS` is slow enough
 * to look like a resting face and short enough that a window left open overnight is
 * not one frozen expression.
 *
 * @module client/companion/eyes/pools
 */
import type { StateId } from '../engine/states.ts'
import type { RingName } from './rings.ts'

/** One state's faces, and how long each is held. */
export interface FacePool {
  /** Milliseconds one outline of this pool is drawn before the pool advances. */
  readonly intervalMs: number
  /** The outlines, most-itself first; a single entry is a state that does not rotate. */
  readonly faces: readonly RingName[]
}

/**
 * How long one outline of a busy state's pool is held.
 *
 * Bounded below by the pose morphs it has to finish inside: the eyes arrive over the
 * destination pose's own `morph` (`./faces.ts`), and an interval shorter than that
 * would leave every face permanently mid-change. The longest morph a rotating state
 * carries is 0.6 s (`thinking`'s own table entry), so this keeps two and a half times
 * that — the margin is what makes the last third of every interval a *rest*, which is
 * what a reader reads as a face rather than as a smear.
 */
export const BUSY_FACE_INTERVAL_MS = 1_500

/**
 * How long one outline of the resting pool is held.
 *
 * Deliberately slower than the busy interval. The resting floor is what a user looks
 * at while they are *reading* — a plan, a diff, their own typing — so a face that moved
 * at working speed would pull the eye back to the strip instead of staying a presence.
 *
 * The gap between the two is the whole of "a working session looks busier than a waiting
 * one", and it is a *ratio* rather than either number: 1.5 s against 4.2 s is nearly three
 * changes for one, which reads as effort without the resting face going still. Both are
 * asserted as a pair in the spec, because a drift that closed the gap (or reversed it)
 * would be a change nobody could see in a constant's name.
 */
export const RESTING_FACE_INTERVAL_MS = 4_200

/**
 * Every state's face pool.
 *
 * Total over the engine's states, for the reason `../poses.ts` gives about its own
 * table: "does not rotate" has to be a decision somebody wrote down, not a state that
 * fell through.
 */
export const FACE_POOLS: Readonly<Record<StateId, FacePool>> = {
  // The resting floor, and the one a report about monotony is usually about: waiting for
  // input is where a session spends its idle time. All five are quiet eyes — the face looks
  // around, settles, and gets heavy-lidded; nothing here claims an outcome. Five at the
  // resting interval is a cycle of twenty-one seconds, which is long enough that a reader
  // who looks twice at a plan does not see the same pair twice in a row.
  idle: { intervalMs: RESTING_FACE_INTERVAL_MS, faces: ['open', 'half', 'oval', 'glint', 'tired'] },
  // The turn is open and nothing has been emitted. Seven entries, and the only pool that
  // reaches both "noticed something" (`curious`) and "working at it" (`squint`): pondering
  // is the state a reader watches longest, so it gets the widest vocabulary — and nothing
  // here says a result, which is the constraint the whole table is written under.
  thinking: { intervalMs: BUSY_FACE_INTERVAL_MS, faces: ['open', 'half', 'oval', 'dot', 'glint', 'curious', 'squint'] },
  // Tools in flight: attention first, then the same set minus the round pupil — a tool run
  // is not a moment to look surprised at, and the narrowed pair is what the state is for.
  orbit: { intervalMs: BUSY_FACE_INTERVAL_MS, faces: ['glint', 'half', 'squint', 'open', 'curious', 'oval'] },
  // The reply is streaming: watching the words arrive, which is the one busy state where a
  // wide eye is the *point* — so `open` and `oval` lead and the two narrowed shapes in
  // between read as the reader following along rather than as a change of mood.
  comet: { intervalMs: BUSY_FACE_INTERVAL_MS, faces: ['open', 'oval', 'half', 'curious', 'glint', 'squint'] },

  // Not rotating. The one-shots are over before a second outline could arrive; the
  // faceless poses (`thinking`'s own body, `alert`, `exclaim`, `sleep`) draw no eyes at
  // all; and the outcome states keep the face that *is* their message.
  wink: { intervalMs: RESTING_FACE_INTERVAL_MS, faces: ['open'] },
  wide: { intervalMs: RESTING_FACE_INTERVAL_MS, faces: ['open'] },
  notify: { intervalMs: RESTING_FACE_INTERVAL_MS, faces: ['dot'] },
  exclaim: { intervalMs: RESTING_FACE_INTERVAL_MS, faces: ['open'] },
  sleep: { intervalMs: RESTING_FACE_INTERVAL_MS, faces: ['open'] },
  egg: { intervalMs: RESTING_FACE_INTERVAL_MS, faces: ['oval'] },
  hexagon: { intervalMs: RESTING_FACE_INTERVAL_MS, faces: ['dot'] },
  play: { intervalMs: RESTING_FACE_INTERVAL_MS, faces: ['open'] },
  swirl: { intervalMs: RESTING_FACE_INTERVAL_MS, faces: ['half'] },
  burst: { intervalMs: RESTING_FACE_INTERVAL_MS, faces: ['beam'] },
  alert: { intervalMs: RESTING_FACE_INTERVAL_MS, faces: ['open'] },
}

/**
 * How long a state holds one outline, in milliseconds.
 * @param state - the semantic state on screen.
 * @returns its pool's interval.
 */
export function faceIntervalMs(state: StateId): number {
  return FACE_POOLS[state].intervalMs
}

/**
 * A stable 32-bit seed for a state's name.
 *
 * FNV-1a over the id, so the seed is a property of the name rather than of its
 * position in a table: adding a state must not change which face another state's pool
 * happens to start on, because that would make a screenshot differ for a reason no
 * reader could trace.
 * @param state - the state id.
 * @returns a non-negative 32-bit seed.
 */
function faceSeed(state: StateId): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < state.length; index += 1) {
    hash = Math.imul(hash ^ state.charCodeAt(index), 0x01000193)
  }
  return hash >>> 0
}

/** Seeds, computed once: a state id is a constant string. */
const SEEDS = new Map<StateId, number>(
  (Object.keys(FACE_POOLS) as StateId[]).map(state => [state, faceSeed(state)]),
)

/**
 * Where a cycle starts in the pool.
 *
 * A hash of the seed and the cycle index, then a modulo. Integer ops (`Math.imul`,
 * `>>>`) because the ordinary float form of an xorshift clamps to the double's mantissa
 * and loses exactly the high bits this reads.
 * @param seed - the state's seed.
 * @param cycle - how many complete walks the pool has made; negative means before entry.
 * @param length - how many entries the pool has.
 * @returns an index in `[0, length)`.
 */
function cycleStart(seed: number, cycle: number, length: number): number {
  let value = (seed ^ Math.imul(cycle + 1, 0x9e3779b1)) | 0
  value = Math.imul(value ^ (value >>> 15), 0x2c1b3c6d)
  value = Math.imul(value ^ (value >>> 12), 0x297a2d39)
  return ((value ^ (value >>> 15)) >>> 0) % length
}

/**
 * Which outline this state wears at this instant.
 *
 * Pure, and a function of the shared clock, for the reason the module note gives. A
 * one-entry pool returns its entry whatever the time is — that is the non-rotating
 * case, stated once — and a frozen companion returns it too, which is the rule
 * `../poses.ts` applies to a rotation: a rotation is motion, so reduced motion gets the
 * state's own face and nothing else.
 * @param state - the semantic state on screen.
 * @param nowMs - monotonic milliseconds, from the shared clock.
 * @param motion - whether animation is wanted; false returns the state's own face.
 * @returns the outline to draw.
 */
export function facePoolAt(state: StateId, nowMs: number, motion: boolean): RingName {
  const pool = FACE_POOLS[state]
  const settled = pool.faces[0]
  /* v8 ignore next -- the table is total and no pool is empty, which the spec pins */
  if (settled === undefined) return 'open'
  const length = pool.faces.length
  if (!motion || length <= 1) return settled
  const step = Math.floor(Math.max(0, nowMs) / pool.intervalMs)
  const cycle = Math.floor(step / length)
  const position = step - cycle * length
  const seed = SEEDS.get(state) ?? 0
  let at = (position + cycleStart(seed, cycle, length)) % length
  // The one step that can follow its own twin: the first of a cycle, when the hash put
  // this cycle's start where the last one ended. Nudged *backwards*, so it cannot land on
  // the step that comes next either — one ahead would be the next entry of this same
  // rotation. Only pools of four and up rotate, which is what makes the nudge safe.
  if (cycle > 0 && position === 0 && at === (length - 1 + cycleStart(seed, cycle - 1, length)) % length) {
    at = (at - 1 + length) % length
  }
  return pool.faces[at] ?? settled
}
