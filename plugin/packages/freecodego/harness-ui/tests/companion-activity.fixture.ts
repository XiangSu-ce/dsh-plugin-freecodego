/**
 * The companion's live activity feed, as a spec drives it.
 *
 * The real source reads a Session's event window (`src/client/companion/activity.ts`),
 * which a seat's spec has no reason to assemble: what a seat does with the feed is
 * read its facts, so the fixture publishes them directly. It implements the same
 * interface the plugin hands the seats, including `dispose`, so an installer under
 * test cannot tell the difference and nothing here has to be stubbed globally.
 *
 * `publish` reports a change to subscribers but does not wrap itself in `act`: a
 * caller inside a React test owns that, exactly as it does for an animation frame.
 */
import { IDLE_ACTIVITY, type CompanionActivity, type CompanionActivitySource } from '../src/client/companion/activity.ts'

/** A driven feed: the source a seat reads, plus the case's own reporting. */
export interface ActivityFixture extends CompanionActivitySource {
  /**
   * Change one fact and notify subscribers.
   * @param next - the facts that change; the rest keep their value.
   */
  publish(next: Partial<CompanionActivity>): void
  /** @returns whether the owner disposed this feed. */
  disposed(): boolean
}

/**
 * @param initial - the facts to start from; every unset one is idle.
 * @returns a feed the case can publish into.
 */
export function activityFixture(initial: Partial<CompanionActivity> = {}): ActivityFixture {
  let value: CompanionActivity = { ...IDLE_ACTIVITY, ...initial }
  let disposed = false
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose: () => {
      disposed = true
      listeners.clear()
    },
    publish: (next: Partial<CompanionActivity>) => {
      value = { ...value, ...next }
      for (const listener of [...listeners]) listener()
    },
    disposed: () => disposed,
  }
}
