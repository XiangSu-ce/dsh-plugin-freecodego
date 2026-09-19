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
 *   the same way, from one place.
 * - **The publication.** Signals are projected, the arbiter decides, and the frame
 *   is sampled on the shared clock's tick. A frozen companion skips ticks whose
 *   pose has not changed, and a state change resets rather than transitions, so a
 *   reduced-motion seat shows the pose itself rather than a morph caught halfway.
 *
 * What stays with a seat is what is genuinely the seat's own: how large it draws,
 * which slot it occupies, and whether it wants a label.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { UseSessionStatus, UseSessions } from '@deepseek-ai/dsh-client-ui-session/client'
import type { JobView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { BotEngine, type BotFrame } from './engine/engine.ts'
import { RAYON } from './engine/repere.ts'
import { STATE_BY_ID, type StateId } from './engine/states.ts'
import { CompanionArbiter } from './arbiter.ts'
import { companionClock } from './driver.ts'
import { emptyMemory, projectSignals, type CompanionObservation, type CompanionSignalMemory } from './signals.ts'

/** Stable empty job list, so a selector never returns a fresh array. */
const NO_JOBS: readonly JobView[] = []

/** @returns whether a job is still open, following the jobs surface's own reading. */
function isLiveJob(job: JobView): boolean {
  return job.status === 'running' || job.status === 'stopping'
}

/** Mutable per-mount state, kept out of React so ticks never re-create it. */
interface CompanionRuntime {
  readonly engine: BotEngine
  readonly arbiter: CompanionArbiter
  memory: CompanionSignalMemory
  /** Last state whose frame was published, so a frozen companion can skip ticks. */
  published: StateId | undefined
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

/** The global standard kit both seats read their facts through. */
export interface CompanionFactHooks {
  /** Selector hook over the Session Controller list and current selection. */
  readonly useSessions: UseSessions
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
 * @returns what `projectSignals` consumes.
 */
export function useCompanionObservation(
  hooks: CompanionFactHooks,
  sessionId: SessionId | undefined,
): CompanionObservation {
  const running = hooks.useSessions(state => sessionId !== undefined && state.byId[sessionId]?.running === true)
  const liveJobs = hooks.useSessions(state =>
    sessionId === undefined ? 0 : (state.jobsBySession[sessionId] ?? NO_JOBS).filter(isLiveJob).length)
  // The newest failure, by identity rather than as a boolean: the host's list is
  // append-ordered and drains nothing, so the last failed entry is the most
  // recently started one, and its id is what changes when another job fails. A
  // boolean here would pin the failure pose for the rest of the session — see
  // `CompanionObservation.failedJobKey`.
  const failedJobKey = hooks.useSessions((state) => {
    if (sessionId === undefined) return undefined
    let newest: string | undefined
    for (const job of state.jobsBySession[sessionId] ?? NO_JOBS) {
      if (job.status === 'failed') newest = job.id
    }
    return newest
  })
  // The status snapshot is the successor of the pending-interaction map: the
  // request itself moved under `SessionStatus.pendingInteraction`, which is the
  // highest-precedence domain request for that session. Presence of the field is
  // the whole question here — a seat cares that *something* is being asked of the
  // user, not which domain asked.
  const awaitingInteraction = hooks.useSessionStatus(statuses =>
    sessionId !== undefined && statuses.get(sessionId)?.pendingInteraction !== undefined)
  return { running, liveJobs, failedJob: failedJobKey !== undefined, failedJobKey, awaitingInteraction }
}

/** The published pose: one frame, and the name of the state that produced it. */
export interface CompanionView {
  /** The engine frame to draw. Render-only; the caller owns the clock. */
  frame: BotFrame
  /** Which state is showing, for the label and for `data-fcg-state`. */
  state: StateId
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
  }))

  const reducedRef = useRef(reducedMotion)
  reducedRef.current = reducedMotion

  const publish = useCallback((): void => {
    const runtime = runtimeRef.current
    /* v8 ignore next -- the ref is filled during the first render, before any subscriber can run */
    if (runtime === undefined) return
    const clock = companionClock()
    const nowSeconds = clock.nowSeconds()
    const projected = projectSignals(observationRef.current, nowSeconds * 1000, runtime.memory)
    runtime.memory = projected.memory
    const decision = runtime.arbiter.decide(projected.signals, nowSeconds * 1000)
    if (decision.changed) {
      // Resetting rather than transitioning is what makes a frozen companion
      // show the pose itself instead of a morph caught halfway.
      if (reducedRef.current) runtime.engine.reset(decision.state, 0)
      else runtime.engine.setState(decision.state, nowSeconds)
    }
    const frozen = reducedRef.current
    if (frozen && !decision.changed && runtime.published === decision.state) return
    runtime.published = decision.state
    const frame = frozen
      ? runtime.engine.sample(frozenAtSeconds(decision.state))
      : runtime.engine.sample(nowSeconds)
    setView({ frame, state: decision.state })
  }, [])

  const publishRef = useRef(publish)
  publishRef.current = publish

  useEffect(() => {
    publishRef.current()
    return companionClock().subscribe(() => { publishRef.current() })
  }, [])

  return view
}
