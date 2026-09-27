/**
 * The companion drawn where no slot can hand it its facts.
 *
 * Every *seat* gets its session facts as Hooks the framework builds over two
 * stores; an injected row (`./running-row.tsx`, `./step-row.tsx`) is outside the
 * slot system, so it reads those same stores itself. That difference is a
 * subscription wrapper and nothing else — the facts are the readers in
 * `./signals.ts`, the pose is the same arbiter, and the frame comes from the same
 * engine through the same `useCompanionView`, which is what keeps an injected face
 * and the strip above the composer from ever disagreeing.
 */
import type { ReactNode } from 'react'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { JobsSnapshot } from '@deepseek-ai/dsh-api-job-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { CompanionActivity } from './activity.ts'
import { CompanionSvg } from './render.tsx'
import { COMPANION_BODY, COMPANION_EYES, COMPANION_HALO, COMPANION_SURFACE } from './palette.ts'
import { useCompanionView, useObservedCompanionObservation } from './view.ts'

/** The four sources the fact readers need: three snapshots and the live event feed. */
export interface StoreFaceSources {
  readonly sessions: HostObservable<SessionListState>
  /** The client jobs snapshot; the same service a slot seat binds as `useJobs`. */
  readonly jobs: HostObservable<JobsSnapshot>
  readonly statuses: HostObservable<SessionStatusSnapshot>
  /** The session's own event log; the *same* instance every slot seat reads. */
  readonly activity: HostObservable<CompanionActivity>
}

/**
 * The character for one injected row.
 * @param props.sources - the session list and status observables.
 * @param props.size - the square edge to draw at, in pixels.
 * @param props.className - the drawing's class, as its stylesheet spells it.
 * @returns the face.
 */
export function StoreFace({ sources, size, className }: {
  readonly sources: StoreFaceSources
  readonly size: number
  readonly className: string
}): ReactNode {
  const view = useCompanionView(
    useObservedCompanionObservation(sources.sessions, sources.jobs, sources.statuses, sources.activity),
  )
  return (
    <CompanionSvg
      frame={view.frame}
      size={size}
      state={view.state}
      pose={view.pose}
      expression={view.expression}
      expressionSource={view.expressionSource}
      face={view.face}
      ink={COMPANION_BODY}
      eye={COMPANION_EYES}
      paper={COMPANION_SURFACE}
      halo={COMPANION_HALO}
      className={className}
    />
  )
}
