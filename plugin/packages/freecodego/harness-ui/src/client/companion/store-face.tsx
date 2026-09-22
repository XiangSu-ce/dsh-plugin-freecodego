/**
 * The companion drawn where no slot can hand it its facts.
 *
 * Every *seat* gets its session facts as Hooks the framework builds over two
 * stores; an injected row (`./running-row.tsx`, `./step-row.tsx`) is outside the
 * slot system, so it reads those same two stores itself. That difference is a
 * subscription wrapper and nothing else — the facts are the readers in
 * `./signals.ts`, the pose is the same arbiter, and the frame comes from the same
 * engine through the same `useCompanionView`, which is what keeps an injected face
 * and the strip above the composer from ever disagreeing.
 */
import type { ReactNode } from 'react'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { CompanionActivity } from './activity.ts'
import { CompanionSvg } from './render.tsx'
import { useCompanionView, useObservedCompanionObservation } from './view.ts'

/** Both seats' body colour: the surrounding text colour, through the token layer. */
export const STORE_FACE_INK = 'var(--fcg-text-primary, currentColor)'

/** The surface behind the character; only visible through the eye holes. */
export const STORE_FACE_PAPER = 'var(--fcg-bg-base, #f9f9f9)'

/** The three sources the fact readers need: two snapshots and the live event feed. */
export interface StoreFaceSources {
  readonly sessions: HostObservable<SessionListState>
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
    useObservedCompanionObservation(sources.sessions, sources.statuses, sources.activity),
  )
  return (
    <CompanionSvg
      frame={view.frame}
      size={size}
      state={view.state}
      ink={STORE_FACE_INK}
      paper={STORE_FACE_PAPER}
      className={className}
    />
  )
}
