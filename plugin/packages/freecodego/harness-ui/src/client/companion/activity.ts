/**
 * What the Session's own event log says the agent is doing, right now.
 *
 * The rest of the companion reads the Session *list* and the status snapshot, and
 * those two say one thing about a turn: it is running. They cannot separate the
 * phases inside it — the model thinking, the reply being written, a tool call
 * executing, the turn failing — because both are projections that keep only the
 * summary. The session's own event window is where those phases actually live, and
 * it is already fed to the client for the transcript, so this module reads the
 * same window rather than asking the Host for a second feed.
 *
 * What it publishes is the share of the observation that only the event log can
 * answer — see `CompanionObservation`, whose `streaming`, `notified`, and the
 * three identities below are exactly this module's output. The names match on
 * purpose: a reader spreads one of these onto an observation, and there is no
 * place for the two spellings to drift.
 *
 * Three decisions are this module's own:
 *
 * - **One instance per plugin, not per seat.** The character is drawn in several
 *   seats at once (the rail's mark, the strip above the composer, the injected
 *   rows), and they must agree. Part of agreement is reading the same facts at the
 *   same instant: a seat that mounted a moment later would miss a `turn/start` and
 *   announce nothing where the others play the greeting. So the source is created
 *   once, by `installCompanion`, and handed to every seat.
 * - **The deltas are the feed.** Every accepted window mutation publishes its own
 *   `change`, which is the exact set of entries that moved — so a read is the new
 *   entries processed in order, not a re-scan of a history that can hold the whole
 *   conversation. A `replace` (a history reload) is the one case that re-reads the
 *   window, and it re-reads only its tail.
 * - **Identities, not flags.** A start, a failure, and an injected message are
 *   *news*: they happened at one instant and are worth drawing once. Each is
 *   published as the durable identity (`seq`) of the event that carried it, and the
 *   caller's news window (`signals.ts`) is what turns a new identity into a bounded
 *   signal. A level boolean over the window could not do this — the window never
 *   drains, so "there is a failed turn in the log" stays true forever.
 *
 * Seeding is the one place this module is deliberately approximate. Binding to a
 * Session that already holds a turn (a seat mounting mid-turn, or a switch into one)
 * reads the continuous facts — a tool in flight, a reply being written — back out of
 * the tail of the window, so the pose is right from the first frame. The live
 * reading counts a step's calls against its results; the seed counts a turn's, which
 * is the same number whenever every call was answered, and is only ever larger for a
 * call the log never closed. Identities are *not* seeded: a turn that failed before
 * this source was looking is history, not news, and replaying it would open every
 * freshly mounted seat on a failure from ten minutes ago.
 */
import type {
  ISessions,
  SessionEventLikeEntry,
  SessionEventSource,
  SessionEventWindow,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { mainViewSessionId } from './signals.ts'

/**
 * The Session facts only the event log carries.
 *
 * Every field matches its name in `CompanionObservation`, so a reader spreads this
 * object onto one. The three identities are undefined until the corresponding event
 * is seen live; see the module note on seeding.
 */
export interface CompanionActivity {
  /** A tool or command call is in flight right now. */
  readonly toolRunning: boolean
  /**
   * The assistant is writing right now.
   *
   * Only a *text* chunk counts. Reasoning arrives on the same feed, and the two mean
   * different things: a model working through a problem is the turn thinking, while
   * a model writing is the reply arriving — and the engine has a pose for each.
   */
  readonly streaming: boolean
  /** Identity of the newest `turn/start`, or undefined when none was seen live. */
  readonly startKey: string | undefined
  /** Identity of the newest turn that ended in failure, or undefined. */
  readonly failureKey: string | undefined
  /** Identity of the newest message injected from outside the turn, or undefined. */
  readonly noticeKey: string | undefined
}

/** The published activity of the Session the main view is showing. */
export type CompanionActivitySource = HostObservable<CompanionActivity> & {
  /** Stop following the Session list and the bound Session's events. */
  dispose(): void
}

/**
 * The feed as a slot seat receives it.
 *
 * Both the rail's mark and the strip above the composer register with this inject
 * face, so the seat that has no session scope of its own reads the same live feed as
 * the one that does — the property every seat here exists to keep.
 */
export interface CompanionSeatInjected {
  readonly activity: CompanionActivitySource
}

/** Every fact false and every identity unset: a Session that is doing nothing. */
export const IDLE_ACTIVITY: CompanionActivity = Object.freeze({
  toolRunning: false,
  streaming: false,
  startKey: undefined,
  failureKey: undefined,
  noticeKey: undefined,
})

/** The look of the Session service this source needs; `ctx.sessions` satisfies it. */
export interface CompanionActivitySessions {
  readonly list: ISessions['list']
  binding(id: SessionId): ReturnType<ISessions['binding']>
}

/**
 * How far back a seed reads the window.
 *
 * A seed stops at the nearest turn or step boundary within this many entries, and
 * gives up past it rather than walking a conversation's whole history to find one.
 * The bound only matters for a Session whose current turn is enormous — the seeded
 * facts are then the turn's own tally either way.
 */
export const ACTIVITY_SEED_LIMIT = 400

/** @returns whether two readings say the same thing. */
function sameActivity(left: CompanionActivity, right: CompanionActivity): boolean {
  return left.toolRunning === right.toolRunning
    && left.streaming === right.streaming
    && left.startKey === right.startKey
    && left.failureKey === right.failureKey
    && left.noticeKey === right.noticeKey
}

/** The window the reader follows and the identity of the Session it came from. */
interface ActivityBinding {
  readonly sessionId: SessionId
  readonly source: SessionEventSource
}

/**
 * Follow the main view's Session and publish what its events say.
 *
 * One object per plugin: `installCompanion` creates it, every seat reads it, and
 * the same instance is what makes them agree about a turn's phases.
 */
class SessionActivity implements CompanionActivitySource {
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribeList: () => void
  private value: CompanionActivity = IDLE_ACTIVITY
  private binding: ActivityBinding | undefined
  private unsubscribeEvents: (() => void) | undefined
  private pendingCalls = 0
  private writing = false
  private startKey: string | undefined
  private failureKey: string | undefined
  private noticeKey: string | undefined

  /**
   * @param sessions - the Session service; its list is what says which Session is
   * shown, and its bindings are what carry the event windows.
   */
  constructor(private readonly sessions: CompanionActivitySessions) {
    this.rebind(mainViewSessionId(sessions.list.getSnapshot()))
    this.unsubscribeList = sessions.list.subscribe(() => { this.follow() })
  }

  /** @returns the current reading. */
  getSnapshot(): CompanionActivity { return this.value }

  /**
   * @param listener - invalidation callback, run once per changed reading.
   * @returns unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Stop following the Session list and its events. */
  dispose(): void {
    this.unsubscribeList()
    this.unsubscribeEvents?.()
    this.unsubscribeEvents = undefined
    this.binding = undefined
    this.listeners.clear()
  }

  /** Follow the shown Session, rebinding only when the identity actually moves. */
  private follow(): void {
    const next = mainViewSessionId(this.sessions.list.getSnapshot())
    if (next === this.binding?.sessionId) {
      // A rebind is needed for a binding that did not exist yet: the Session can be
      // listed and shown before its Client generation is retained, and the window
      // only exists once it is.
      if (next === undefined || this.sessions.binding(next) !== undefined) return
    }
    this.rebind(next)
  }

  /**
   * Move to another Session's window, or to none.
   *
   * The continuous facts start from the new window's tail (see the module note);
   * the identities start unset, because a start or a failure that happened before
   * this binding is a fact about the past, not news.
   * @param sessionId - the Session the main view shows, or undefined.
   */
  private rebind(sessionId: SessionId | undefined): void {
    this.unsubscribeEvents?.()
    this.unsubscribeEvents = undefined
    this.binding = undefined
    this.pendingCalls = 0
    this.writing = false
    this.startKey = undefined
    this.failureKey = undefined
    this.noticeKey = undefined
    if (sessionId !== undefined) {
      const source = this.sessions.binding(sessionId)?.eventSource
      if (source !== undefined) {
        this.binding = { sessionId, source }
        this.seed(source.getSnapshot())
        this.unsubscribeEvents = source.subscribe(() => { this.receive() })
      }
    }
    this.publish()
  }

  /** Read the newest accepted delta, falling back to the window's tail on a replace. */
  private receive(): void {
    const source = this.binding?.source
    if (source === undefined) return
    const snapshot = source.getSnapshot()
    const change = snapshot.change
    if (change.kind === 'settle-assistant') {
      // A durable assistant event superseded this attempt's transient rows: the
      // reply is settled, so whatever was being written is written.
      this.writing = false
    } else if (change.kind === 'replace') {
      this.pendingCalls = 0
      this.writing = false
      this.seed(snapshot)
    } else if (change.kind === 'append') {
      for (const entry of change.entries) this.accept(entry)
    } else {
      // `prepend` extends the window with older history. Nothing about *now* is in
      // it, and the seed's boundaries are behind it, so it is deliberately ignored.
      return
    }
    this.publish()
  }

  /**
   * Apply one accepted entry.
   * @param entry - the durable event, or the client-only live chunk, that moved.
   */
  private accept(entry: SessionEventLikeEntry): void {
    if (entry.type === 'transient') {
      // A live chunk is the assistant's stream arriving: it exists while the reply
      // is being written and is replaced by the durable message when it settles.
      // Reasoning is that same stream, but it is not the reply being written.
      this.writing = entry.event.data.chunk.type === 'text-delta'
      return
    }
    const event = entry.event
    switch (event.type) {
      case 'turn/start':
        this.pendingCalls = 0
        this.writing = false
        this.startKey = `${event.seq}`
        break
      case 'turn/end':
        this.pendingCalls = 0
        this.writing = false
        if (event.data.reason.kind === 'error') this.failureKey = `${event.seq}`
        break
      case 'step/start':
      case 'step/end':
        // A step's calls are answered within it; a call the step never closed is not
        // work that is still happening.
        this.pendingCalls = 0
        break
      case 'tool/call':
        this.pendingCalls += 1
        this.writing = false
        break
      case 'tool/result':
        this.pendingCalls = Math.max(0, this.pendingCalls - 1)
        break
      case 'assistant/message':
        this.writing = false
        break
      case 'user/message':
        // Only a message this turn did not ask for is news: the loop's own
        // `agent.inject()` context (a cron notice, a file-change notice, a subagent
        // result) carries a plugin source, while the human's prompt carries `user`.
        if (event.data.source.kind === 'plugin') this.noticeKey = `${event.seq}`
        break
      default:
        break
    }
  }

  /**
   * Read the continuous facts back out of a window's tail.
   * @param window - the window to read; only its newest turn or step is inspected.
   */
  private seed(window: SessionEventWindow): void {
    const entries = window.entries
    let calls = 0
    let results = 0
    let writing = false
    let index = entries.length - 1
    for (let seen = 0; index >= 0 && seen < ACTIVITY_SEED_LIMIT; index -= 1, seen += 1) {
      const entry = entries[index]
      if (entry === undefined) continue
      if (entry.type === 'transient') {
        // The newest reply entry decides: a text chunk is a reply being written, a
        // reasoning chunk is not, and either one ends the walk.
        writing = entry.event.data.chunk.type === 'text-delta'
        break
      }
      const type = entry.event.type
      if (type === 'turn/start' || type === 'step/start' || type === 'step/end') break
      if (type === 'tool/call') calls += 1
      else if (type === 'tool/result') results += 1
      else if (type === 'assistant/message') {
        // The newest reply entry decides whether a reply is being written; a durable
        // message is the settled form of the chunks that preceded it.
        break
      }
    }
    this.pendingCalls = Math.max(0, calls - results)
    this.writing = writing
  }

  /** Publish a reading, and tell subscribers when it differs from the last one. */
  private publish(): void {
    const next: CompanionActivity = {
      toolRunning: this.pendingCalls > 0,
      streaming: this.writing,
      startKey: this.startKey,
      failureKey: this.failureKey,
      noticeKey: this.noticeKey,
    }
    if (sameActivity(this.value, next)) return
    this.value = next
    for (const listener of [...this.listeners]) listener()
  }
}

/**
 * Start following the shown Session's events.
 * @param sessions - the Session service, usually `ctx.sessions`.
 * @returns the source every seat reads, owned by the caller that created it.
 */
export function createCompanionActivity(sessions: CompanionActivitySessions): CompanionActivitySource {
  return new SessionActivity(sessions)
}
