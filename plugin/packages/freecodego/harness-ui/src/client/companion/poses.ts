/**
 * The poses a state may be drawn with.
 *
 * Why this exists
 * --------------
 * The vocabulary has fifteen states, and one of them is what a session spends most
 * of a turn in: `thinking`. It is a single, fixed body animation — its own pose
 * function replaces the silhouette with a small pulsing dot and sets `eyeAlpha: 0`
 * — so a reader watching a long turn sees the same three dots for a minute, and
 * `orbiting`, `streaming`, and the rest each do the same. The picture says "busy"
 * once and then repeats itself.
 *
 * A **pool** is the fix, and it is deliberately *not* a change to the ladder. The
 * ladder answers a semantic question ("what is this session doing"), and that
 * answer has to stay exact: it drives the label, the accessible status text, and
 * `data-fcg-state`. What a pool varies is only the *drawing* — which of the
 * engine's poses illustrates that answer at this instant. So a turn that is
 * thinking still says 思考中 while the character keeps changing shape, and the
 * words never contradict the session.
 *
 * Three decisions this file makes
 * -------------------------------
 * - **The step comes from the shared clock, never from a counter.** Several seats
 *   draw one character; the clock is the one thing they all share exactly. A
 *   per-seat counter would let a seat that mounted later walk its pool out of step
 *   with the others, which is two poses for one instant in two places on screen.
 *   `restlessStep` in `./signals.ts` is the same idea for the resting flourish.
 * - **The interval is derived, not declared.** A pose that declares a `minDuration`
 *   has said that cutting it earlier leaves the body mid-morph, so a pool that
 *   rotated faster than its longest pose would be cutting every pose short — a
 *   value written down beside the pool would drift the moment a longer pose joined
 *   it. {@link posePoolIntervalMs} reads the engine's own table instead, and the
 *   interval is therefore invariant by construction.
 * - **A pool holds poses that claim nothing.** The rule is about what a rotation
 *   must not do: a busy state may not flicker through `burst` ("Done"), `exclaim`
 *   ("Failed"), `alert` ("Waiting for you"), or `sleep` ("Asleep"), because the
 *   words stay semantic and the drawing would be arguing with them. The poses a
 *   busy pool draws from are the working poses and the shape flourishes, which
 *   already describe no session fact — `restless` uses the same flourishes at rest
 *   for exactly that reason.
 *
 * Every state is listed, so a state added to the engine stops compiling here until
 * someone decides whether it rotates — the property `./companion-locale.ts` gets
 * from keying its dictionary by state id.
 *
 * @module client/companion/poses
 */
import { STATE_BY_ID, type StateId } from './engine/states.ts'

/** The poses one state may be drawn with, most-itself first. */
export type PosePool = readonly StateId[]

/**
 * Every state's pool.
 *
 * A one-entry pool is a state that does not rotate, which is why the map is total:
 * "does not rotate" is the degenerate case rather than a missing entry, so there is
 * no branch in {@link poseFor} and no way for a state to be silently unclassified.
 *
 * Only the long-lived busy states rotate. The one-shots (`burst`, `notify`, `play`)
 * are over before a second pose could arrive, and the ones that carry a meaning a
 * reader acts on (`alert`, `exclaim`) must be still while they are on screen.
 */
export const POSE_POOLS: Readonly<Record<StateId, PosePool>> = {
  // The turn is open and nothing has been emitted yet: the longest-running pose in
  // the vocabulary, and the one the report was about.
  thinking: ['thinking', 'egg', 'wide', 'hexagon'],
  // Tools in flight. `thinking` joins it because a turn whose tools are running is
  // also a turn whose model is working, so the two read as one idea.
  orbit: ['orbit', 'thinking', 'egg', 'hexagon'],
  // The reply is streaming.
  comet: ['comet', 'thinking', 'wide', 'hexagon'],

  // Not rotating: the resting floor, the two quiet ends, the one-shots, and the
  // three poses a reader is asked to act on or read as an outcome.
  idle: ['idle'],
  wink: ['wink'],
  wide: ['wide'],
  notify: ['notify'],
  exclaim: ['exclaim'],
  sleep: ['sleep'],
  egg: ['egg'],
  hexagon: ['hexagon'],
  play: ['play'],
  swirl: ['swirl'],
  burst: ['burst'],
  alert: ['alert'],
}

/**
 * How long one pose of a pool is drawn before the next takes over.
 *
 * The longest pose in the pool, in milliseconds. Read from the engine's table
 * rather than declared, for the reason the module note gives: a pose's `duration`
 * is how long it takes to play, and its `minDuration` (where it has one) is the
 * instant before which cutting it leaves the body mid-morph. Taking the larger of
 * the two, over the whole pool, is the shortest interval that cuts nothing.
 * @param pool - the poses a state rotates through.
 * @returns the interval in milliseconds, at least one.
 */
export function posePoolIntervalMs(pool: PosePool): number {
  let longest = 0
  for (const pose of pool) {
    const definition = STATE_BY_ID.get(pose)
    /* v8 ignore next -- every id in a pool is a key of the engine's own table */
    if (definition === undefined) continue
    longest = Math.max(longest, definition.duration, definition.minDuration ?? 0)
  }
  return Math.max(1, Math.round(longest * 1000))
}

/** Intervals, computed once: a pool is a constant and its table is immutable. */
const INTERVALS = new Map<StateId, number>(
  (Object.keys(POSE_POOLS) as StateId[]).map(state => [state, posePoolIntervalMs(POSE_POOLS[state])]),
)

/**
 * The interval a state rotates at, in milliseconds.
 * @param state - the semantic state on screen.
 * @returns its pool's interval; a state that does not rotate still reports one.
 */
export function poseIntervalMs(state: StateId): number {
  /* v8 ignore next -- the map is total over the state ids, like the table above */
  return INTERVALS.get(state) ?? 1
}

/**
 * Which pose draws this state at this instant.
 *
 * Pure, and a function of the clock rather than of any instance's history, so two
 * seats asking at the same instant get the same answer and a seat that mounted late
 * is not a pose behind. A state whose pool is one pose long returns that pose
 * whatever the time is, which is the non-rotating case stated once.
 * @param state - the semantic state on screen, as the arbiter decided it.
 * @param nowMs - monotonic milliseconds, from the shared clock.
 * @returns the pose to draw.
 */
export function poseFor(state: StateId, nowMs: number): StateId {
  const pool = POSE_POOLS[state]
  if (pool.length <= 1) return state
  // `Math.floor` of a non-negative time is non-negative, so the modulo needs no
  // correction; the fallback is for a pool that is somehow empty.
  const step = Math.floor(Math.max(0, nowMs) / poseIntervalMs(state))
  return pool[step % pool.length] ?? state
}

/**
 * The pose to draw, with the reduced-motion preference applied.
 *
 * The preference is honoured here and nowhere else, so "a rotation is motion" is a
 * property of one function rather than a condition each caller has to remember.
 * The seat's side of it is not observable: a frozen companion redraws only when the
 * words change, so a rotation left ungated would be masked by that short-circuit
 * instead of showing up as a moving picture. Putting the gate where it can be
 * asserted is what keeps it from being decoration.
 * @param state - the semantic state on screen.
 * @param nowMs - monotonic milliseconds, from the shared clock.
 * @param motion - whether animation is wanted; false freezes the state's own pose.
 * @returns the pose to draw.
 */
export function poseAt(state: StateId, nowMs: number, motion: boolean): StateId {
  return motion ? poseFor(state, nowMs) : state
}
