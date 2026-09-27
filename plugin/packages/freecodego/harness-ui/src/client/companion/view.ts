/**
 * The half of the companion both of its seats share.
 *
 * Two surfaces show the same character — the sidebar rail's brand mark and the
 * full-width strip above the composer — and they have to agree. One clock, one
 * ladder, one engine per mounted seat, and the same frame for the same session
 * facts, so the two can never disagree about what the agent is doing. This module
 * is that shared half:
 *
 * - **The session facts.** Both seats read the same global standard kit, because
 *   the framework delivers `GlobalStandardProps` to every slot component whatever
 *   its scope. The rail mark has no session scope of its own, and the dock entry
 *   is handed the session it belongs to, but the *facts* behind the pose are the
 *   ones that need the jobs and the Session status snapshot — so both read them
 *   the same way, from one place. The phases *inside* a turn are a third source,
 *   the session's own event log (`./activity.ts`), which every reader here is
 *   handed the same instance of.
 * - **The publication.** Signals are projected, the arbiter decides, and the frame
 *   is sampled on the shared clock's tick. A frozen companion skips ticks whose
 *   pose has not changed, and a state change resets rather than transitions, so a
 *   reduced-motion seat shows the pose itself rather than a morph caught halfway.
 *
 * What stays with a seat is what is genuinely the seat's own: how large it draws,
 * which slot it occupies, and whether it wants a label.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { JobsSnapshot } from '@deepseek-ai/dsh-api-job-controller/client'
import type { UseSessionStatus, UseSessions, SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { BotEngine, type BotFrame } from './engine/engine.ts'
import { RAYON } from './engine/repere.ts'
import { STATE_BY_ID, type StateId } from './engine/states.ts'
import type { CompanionActivity } from './activity.ts'
import { CompanionArbiter } from './arbiter.ts'
import { companionClock } from './driver.ts'
import { poseAt } from './poses.ts'
import { withRings } from './eyes/apply.ts'
import { EYE_FACES, faceFor, faceRingAt } from './eyes/faces.ts'
import type { RingName } from './eyes/rings.ts'
import {
  awaitingInteraction,
  emptyMemory,
  liveJobCount,
  mainViewSessionId,
  newestFailedJobKey,
  projectSignals,
  sessionRunning,
  type CompanionObservation,
  type CompanionSignalMemory,
} from './signals.ts'

/** Mutable per-mount state, kept out of React so ticks never re-create it. */
interface CompanionRuntime {
  readonly engine: BotEngine
  readonly arbiter: CompanionArbiter
  memory: CompanionSignalMemory
  /** Last state whose frame was published, so a frozen companion can skip ticks. */
  published: StateId | undefined
  /**
   * The pose the engine is currently playing, or `undefined` before the first
   * publish. Tracked separately from `published` because the two answer different
   * questions: `published` is what the reader was last *told*, and this is what the
   * engine is *drawing*. Re-entering the engine for a pose already on screen would
   * restart its morph for no visible change.
   */
  publishedPose: StateId | undefined
  /** The outline the eyes are showing, so a change of face can be told from a redraw. */
  publishedFace: RingName | undefined
  /**
   * The expression and its source the reader was last told, or `null` for neither.
   *
   * Tracked beside `publishedFace` because they answer different questions and one does
   * not imply the other: several names draw one outline (`neutral` and a pool's `open`
   * are the same picture), so an expression can arrive, change source, or end while the
   * eyes are already drawn exactly that way. The published attributes are the *only*
   * thing about a face anything outside the component can read, so a gate that watched
   * the outline alone would leave them saying something no longer true — and would leave
   * a live probe unable to see a request that happened to ask for the current shape.
   */
  publishedExpression: string | null
  /** Which source that expression came from, or `null` when nothing was worn. */
  publishedExpressionSource: 'request' | 'moment' | null
  /**
   * The outline the eyes are coming from, and when they started coming from it.
   *
   * The engine morphs its own eye placement itself, so the only thing `./eyes/faces.ts`
   * needs from this half is what an outline is giving way to and how long it has had:
   * one pair of facts, remembered here rather than derived, because a morph is the one
   * thing about a companion that a clock cannot reconstruct.
   */
  faceFrom: RingName | undefined
  /** Milliseconds, from the shared clock, at which `faceFrom` gave way to the face. */
  faceChangedAtMs: number
}

/**
 * @returns a fresh runtime, at rest.
 *
 * No shape and no expression are passed: `null` is the engine's "no override",
 * which is its own resting circle with a neutral face. Naming the resting shape
 * here instead would mean choosing from the engine's shape table, and a wrong
 * lookup would silently draw a different character.
 */
function createRuntime(): CompanionRuntime {
  // Seed the quiet timer from the shared clock rather than from zero. That clock
  // is a process singleton which may already read minutes (the rail mark mounts
  // at app start, the strip mounts when a session opens), so `emptyMemory(0)`
  // would report a brand-new seat as permanently quiet: it would open on the
  // powered-down pose instead of rest, and only wake on the next activity.
  return {
    engine: new BotEngine(RAYON, 'idle'),
    arbiter: new CompanionArbiter(),
    memory: emptyMemory(companionClock().nowSeconds() * 1000),
    published: undefined,
    publishedPose: undefined,
    publishedFace: undefined,
    publishedExpression: null,
    publishedExpressionSource: null,
    faceFrom: undefined,
    faceChangedAtMs: 0,
  }
}

/**
 * The time to freeze a state at when motion is not wanted.
 *
 * Not an arbitrary mid-point: a state that declares a `minDuration` has said that
 * cutting it earlier leaves the body mid-morph, so its floor is the first
 * instant it is fully itself. A state that declares none loops, so its own
 * midpoint stands for it.
 * @param state - state to freeze.
 * @returns seconds into the state.
 */
function frozenAtSeconds(state: StateId): number {
  const definition = STATE_BY_ID.get(state)
  /* v8 ignore next -- every state the arbiter can name is registered in the engine's table */
  if (definition === undefined) return 0
  return definition.minDuration ?? definition.duration / 2
}

/**
 * @returns the reduced-motion media query, or undefined where the realm has none
 * (a test realm, or any environment without `matchMedia`).
 */
function reducedMotionQuery(): MediaQueryList | undefined {
  // Typed as possibly absent, which is the truth in a realm without it: the jsdom
  // unit lane and any non-browser host implement no `matchMedia`. The DOM lib
  // declares it non-optional, so the optional call needs the narrower type, the
  // same shape `client/ui-attachment` uses for the same query.
  const matchMedia = (globalThis as unknown as { matchMedia?: (query: string) => MediaQueryList }).matchMedia
  return matchMedia?.('(prefers-reduced-motion: reduce)')
}

/** Watch the reduced-motion preference. @returns whether motion should be suppressed. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => reducedMotionQuery()?.matches === true)
  useEffect(() => {
    const query = reducedMotionQuery()
    if (query === undefined) return
    const onChange = (): void => { setReduced(query.matches) }
    // Read once on mount: the preference may have changed between the initial
    // render and this effect, and the listener alone would not report that.
    onChange()
    query.addEventListener('change', onChange)
    return () => { query.removeEventListener('change', onChange) }
  }, [])
  return reduced
}

/**
 * Selector hook over the client jobs snapshot.
 *
 * Jobs are no longer a field of the Session list state: they moved to the `jobs`
 * client service, whose snapshot a consumer binds to its own slot entry through that
 * entry's reserved `hooks` compartment — the standard kit carries no jobs hook. This
 * is the type that binding produces, so a seat's props spell the same thing the
 * registration supplies.
 */
export type UseJobs = SnapshotSelectorHook<JobsSnapshot>

/** The global standard kit both seats read their facts through. */
export interface CompanionFactHooks {
  /** Selector hook over the Session Controller list and current selection. */
  readonly useSessions: UseSessions
  /** Selector hook over the client jobs snapshot of every watched Session. */
  readonly useJobs: UseJobs
  /** Selector hook over the unified Session UI status snapshot. */
  readonly useSessionStatus: UseSessionStatus
}

/**
 * Read the session facts one companion needs, through the global standard kit.
 *
 * Every selector returns a primitive, so a session update cannot re-render a seat
 * through a fresh object identity — the observation is rebuilt each render and
 * compared by value where it is consumed.
 * @param hooks - the seat's standard-prop hooks.
 * @param sessionId - the session to observe; absent means nothing is selected.
 * @param activity - the session's own event log, read live; the phases the two
 * stores above cannot separate never appear in their snapshots at all.
 * @returns what `projectSignals` consumes.
 */
export function useCompanionObservation(
  hooks: CompanionFactHooks,
  sessionId: SessionId | undefined,
  activity: HostObservable<CompanionActivity>,
): CompanionObservation {
  // Every selector body is one question, asked in `./signals.ts` so the injected
  // transcript row asks it the same way; see the note there. Each returns a
  // primitive, which is also why no equality function is needed.
  const running = hooks.useSessions(state => sessionRunning(state, sessionId))
  // The two job questions are asked of the jobs snapshot, not the Session list
  // state: a job roster is no longer part of that snapshot at all.
  const liveJobs = hooks.useJobs(jobs => liveJobCount(jobs, sessionId))
  const failedJobKey = hooks.useJobs(jobs => newestFailedJobKey(jobs, sessionId))
  // The status snapshot is the successor of the pending-interaction map: the
  // request itself moved under `SessionStatus.pendingInteraction`, which is the
  // highest-precedence domain request for that session. Presence of the field is
  // the whole question here — a seat cares that *something* is being asked of the
  // user, not which domain asked.
  const asked = hooks.useSessionStatus(statuses => awaitingInteraction(statuses, sessionId))
  // The activity's fields are named exactly as the observation spells them, so the
  // reading is merged rather than mapped: one shared vocabulary, no second naming.
  return {
    running,
    liveJobs,
    failedJob: failedJobKey !== undefined,
    failedJobKey,
    awaitingInteraction: asked,
    ...useObserved(activity, reading => reading),
  }
}

/**
 * Observe one snapshot source outside the slot system.
 *
 * The framework builds the Hooks a slot receives over exactly these sources (its
 * `provideRoot` hands it `ctx.sessions.list` and `uiSession.sessionStatus`), so
 * this is the same read with the same lifetime and the same selector shape — the
 * only thing it adds is a subscription the framework would otherwise own.
 * @param source - the observable snapshot to follow.
 * @param select - primitive-valued selection; primitives compare by `Object.is`,
 * which is what keeps a re-render loop impossible without an equality function.
 * @returns the selected value, re-read when the source invalidates.
 */
function useObserved<T, S>(source: HostObservable<T>, select: (snapshot: T) => S): S {
  const subscribe = useCallback((listener: () => void) => source.subscribe(listener), [source])
  return useSyncExternalStore(subscribe, () => select(source.getSnapshot()))
}

/**
 * The same observation, read off the stores themselves.
 *
 * For a companion outside the slot system — the injected running row in
 * `./running-row.tsx`, which the host renders into the transcript rather than
 * through a slot. Which Session it describes is the same question the rail mark
 * asks (`mainViewSessionId`), so the two seats and this row follow one Session id
 * and one set of facts.
 * @param sessions - the Session list observable.
 * @param jobs - the client jobs snapshot observable.
 * @param statuses - the unified Session UI status observable.
 * @returns what `projectSignals` consumes.
 */
export function useObservedCompanionObservation(
  sessions: HostObservable<SessionListState>,
  jobs: HostObservable<JobsSnapshot>,
  statuses: HostObservable<SessionStatusSnapshot>,
  activity: HostObservable<CompanionActivity>,
): CompanionObservation {
  const sessionId = useObserved(sessions, mainViewSessionId)
  const running = useObserved(sessions, state => sessionRunning(state, sessionId))
  const liveJobs = useObserved(jobs, state => liveJobCount(state, sessionId))
  const failedJobKey = useObserved(jobs, state => newestFailedJobKey(state, sessionId))
  const asked = useObserved(statuses, snapshots => awaitingInteraction(snapshots, sessionId))
  return {
    running,
    liveJobs,
    failedJob: failedJobKey !== undefined,
    failedJobKey,
    awaitingInteraction: asked,
    ...useObserved(activity, reading => reading),
  }
}

/** The published pose: one frame, and what produced it. */
export interface CompanionView {
  /** The engine frame to draw. Render-only; the caller owns the clock. */
  frame: BotFrame
  /**
   * Which state is showing, for the label and for `data-fcg-state`.
   *
   * This is the arbiter's answer and only its answer: a pool rotates which pose
   * *draws* the state, never which state the session is in, so the words a reader
   * sees cannot disagree with the session they describe.
   */
  state: StateId
  /**
   * The pose that produced `frame` — the state itself for a state that does not
   * rotate, and one of its pool's poses otherwise. Published as `data-fcg-pose` so
   * a change of drawing is observable without pretending the state changed.
   */
  pose: StateId
  /**
   * The expression worn while it holds, and `null` at every other moment — never the
   * outline that is drawn, which is `expression` resolved against the pose and then
   * morphed.
   *
   * Two sources reach it, and `signals.ts` is the one place that decides between them: a
   * request the model made through `freecodego_companion_face`, or a moment the session
   * had (a tool call that came back a failure). Published as
   * `data-fcg-companion-expression`, together with {@link CompanionView.expressionSource}.
   * The face's whole effect is a face, and a face is the one thing nothing outside the
   * component can diff: the eyes are cubic curves inside a mask, redrawn every frame.
   * Publishing it is what makes the feature observable rather than merely plausible — it is
   * how the live run after this shipped confirmed the call had reached the seat.
   */
  expression: string | null
  /**
   * Which source that expression came from, or `null` when nothing is worn.
   *
   * Published as `data-fcg-companion-expression-source`. Worth a second attribute because
   * the two are different claims about the same character: `request` means the model said
   * something about itself, `moment` means the session did, and a reader debugging "why is
   * it frowning" needs to know which channel to look in.
   */
  expressionSource: 'request' | 'moment' | null
  /**
   * The outline the eyes are drawn with at this instant — the state's face, from its
   * pool, or the expression a request put there. Published as `data-fcg-face`.
   *
   * The request above says what was *asked for*; this says what is *drawn*, and they
   * differ for every state whose pool rotates: the eyes are paths inside a mask, and
   * every path changes on every frame anyway (the body breathes, so the eye box moves),
   * so nothing outside the component can tell a rotating face from a still one. It is
   * the same argument `data-fcg-pose` is published under, for the other half of the
   * drawing, and it is what a test reads to assert that a waiting seat's face moves
   * while its words do not.
   */
  face: RingName
}

/**
 * Follow the session activity and publish the pose to draw.
 * @param observation - the session facts, read afresh on every render.
 * @returns the frame to draw and the state that produced it.
 */
export function useCompanionView(observation: CompanionObservation): CompanionView {
  const reducedMotion = useReducedMotion()
  const runtimeRef = useRef<CompanionRuntime | undefined>(undefined)
  if (runtimeRef.current === undefined) runtimeRef.current = createRuntime()
  // Held as a local so the first frame below needs no assertion: the ref is filled
  // on the line above, and a closure would not carry that narrowing.
  const initialRuntime = runtimeRef.current
  const observationRef = useRef(observation)
  // Sync before the subscription effect below runs, and before any later tick.
  useLayoutEffect(() => { observationRef.current = observation })

  const [view, setView] = useState<CompanionView>(() => ({
    frame: initialRuntime.engine.sample(0),
    state: 'idle',
    pose: 'idle',
    expression: null,
    expressionSource: null,
    face: EYE_FACES.idle,
  }))

  const reducedRef = useRef(reducedMotion)
  reducedRef.current = reducedMotion

  const publish = useCallback((): void => {
    const runtime = runtimeRef.current
    /* v8 ignore next -- the ref is filled during the first render, before any subscriber can run */
    if (runtime === undefined) return
    const clock = companionClock()
    const nowSeconds = clock.nowSeconds()
    const nowMs = nowSeconds * 1000
    const projected = projectSignals(observationRef.current, nowMs, runtime.memory)
    runtime.memory = projected.memory
    const decision = runtime.arbiter.decide(projected.signals, nowMs)
    const frozen = reducedRef.current
    // Which pose illustrates that decision at this instant. The reduced-motion
    // preference is applied inside `poseAt`, which is the only place it is applied.
    const pose = poseAt(decision.state, nowMs, !frozen)
    // Driven by the *pose* rather than by the decision: two states can be drawn by
    // one pose, and a re-entry for a pose already on screen would restart its morph
    // for no visible change. Resetting rather than transitioning is what makes a
    // frozen companion show the pose itself.
    // Which outline the state wears, with an expression the model asked for outranking
    // it while it holds. Keyed by the decision rather than by the pose because the face
    // moves on its own clock (`eyes/pools.ts`): the pose pool varies only the three busy
    // states' bodies, so a waiting session would otherwise wear one expression until its
    // words changed.
    const face = faceFor(decision.state, projected.expression, nowMs, !frozen)
    const expression = projected.expression ?? null
    const expressionSource = projected.expressionSource ?? null
    // Every question is asked before anything is applied, because each is a reason to
    // publish: the words changed, the face under them did, or the expression the reader
    // is told about did — including the case where it changed to a name drawn with the
    // outline already on screen, which the outline alone cannot report.
    const poseChanged = pose !== runtime.publishedPose
    const faceChanged = face !== runtime.publishedFace
    const expressionChanged = expression !== runtime.publishedExpression
      || expressionSource !== runtime.publishedExpressionSource
    // A frozen companion draws a face that is a pure function of the state and of a
    // request, so only those two can move it — a rotation cannot, and an arriving
    // request can. That is what makes the gate a behaviour rather than a comment.
    if (frozen && !decision.changed && runtime.published === decision.state && !poseChanged && !faceChanged && !expressionChanged) return
    if (poseChanged) {
      if (frozen) runtime.engine.reset(pose, 0)
      else runtime.engine.setState(pose, nowSeconds)
      runtime.publishedPose = pose
    }
    if (faceChanged) {
      runtime.faceFrom = runtime.publishedFace
      runtime.faceChangedAtMs = nowMs
      runtime.publishedFace = face
    }
    runtime.published = decision.state
    runtime.publishedExpression = expression
    runtime.publishedExpressionSource = expressionSource
    const frame = frozen
      ? runtime.engine.sample(frozenAtSeconds(pose))
      : runtime.engine.sample(nowSeconds)
    // The outline is the last thing applied, so what a seat draws is one frame: the
    // engine's placement with this instant's outline drawn into it. It is applied here
    // rather than in the renderer for the reason the module note gives — the frame is
    // the truth, and a seat that drew its own eyes could disagree with the other seat.
    const ring = faceRingAt(runtime.faceFrom, pose, face, nowMs - runtime.faceChangedAtMs, !frozen)
    setView({
      frame: withRings(frame, ring),
      state: decision.state,
      pose,
      expression,
      expressionSource,
      face,
    })
  }, [])

  const publishRef = useRef(publish)
  publishRef.current = publish

  useEffect(() => {
    publishRef.current()
    return companionClock().subscribe(() => { publishRef.current() })
  }, [])

  return view
}
