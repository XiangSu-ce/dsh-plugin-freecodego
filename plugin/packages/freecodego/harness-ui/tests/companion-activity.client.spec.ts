/**
 * The companion's live feed, over a Session's own event window.
 *
 * This is the one part of the companion that reads something other than the two
 * snapshots the seats are handed, so its contract is the event log's own algebra:
 * which entries move a fact, which of them are *news*, and what a window that already
 * holds a turn means for a seat that has just bound to it. The feed is driven by the
 * real `MutableSessionEventSource`, so a case is the same shape as the delta the
 * transcript assembler sees rather than a hand-made one.
 */

import { describe, expect, it, vi } from 'vitest'
import { MutableSessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  SessionEventLikeEntry,
  SessionEventSource,
  SessionListState,
} from '@deepseek-ai/dsh-api-session-controller/client'
import { createCompanionActivity, type CompanionActivitySessions } from '../src/client/companion/activity.ts'

/** A source a case publishes into, shaped like the framework's observables. */
function source<T>(value: T): {
  getSnapshot: () => T
  subscribe: (listener: () => void) => () => void
  set: (next: T) => void
} {
  let current = value
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (next: T) => {
      current = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/** A list state whose only readable fact is which Session the main view retains. */
function listState(mainView: string | undefined): SessionListState {
  return {
    ids: mainView === undefined ? [] : [mainView],
    byId: Object.fromEntries((mainView === undefined ? [] : [mainView]).map(id => [id, {
      id,
      displayTitle: id,
      running: true,
      blank: false,
      updatedAt: 0,
      retainedBy: { mainView: 1 },
    }])),
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
  } as unknown as SessionListState
}

/** One durable entry, built from a type its data is never read past. */
function entry(type: string, seq: number, data: unknown = {}): SessionEventLikeEntry {
  return { type: 'event', event: { type, seq, time: seq, data } } as unknown as SessionEventLikeEntry
}

/** One client-only live chunk, which is how a streaming reply reaches the window. */
function chunk(seq: number, kind: 'text-delta' | 'reasoning-delta'): SessionEventLikeEntry {
  return {
    type: 'transient',
    event: {
      type: 'assistant/live-chunk',
      seq,
      time: seq,
      data: { attemptId: 'a1', turn: 1, step: 1, chunk: { type: kind, index: 0, text: 'x' } },
    },
  } as unknown as SessionEventLikeEntry
}

/** The service face the feed follows, with the windows a case appends into. */
function sessions(mainView = 's1'): {
  face: CompanionActivitySessions
  window: (id: string) => MutableSessionEventSource
  show: (id: string | undefined) => void
} {
  const list = source(listState(mainView))
  const windows = new Map<string, MutableSessionEventSource>()
  const window = (id: string): MutableSessionEventSource => {
    const existing = windows.get(id)
    if (existing !== undefined) return existing
    const created = new MutableSessionEventSource()
    windows.set(id, created)
    return created
  }
  window('s1')
  window('s2')
  return {
    face: {
      list,
      binding: (id: string) => ({ eventSource: window(id) as SessionEventSource }) as never,
    },
    window,
    show: (id: string | undefined) => { list.set(listState(id)) },
  }
}

describe('companion activity: the phases only the event log carries', () => {
  it('reads a tool call in flight, and the reply being written', () => {
    const feed = sessions()
    const activity = createCompanionActivity(feed.face)
    expect(activity.getSnapshot()).toEqual({
      toolRunning: false,
      streaming: false,
      startKey: undefined,
      failureKey: undefined,
      noticeKey: undefined,
    })

    feed.window('s1').append(entry('tool/call', 4, { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{}' }))
    expect(activity.getSnapshot().toolRunning).toBe(true)

    feed.window('s1').append(entry('tool/result', 5, { turn: 1, step: 1 }))
    expect(activity.getSnapshot().toolRunning).toBe(false)

    feed.window('s1').append(chunk(6, 'text-delta'))
    expect(activity.getSnapshot().streaming).toBe(true)

    // The durable message supersedes the attempt's live rows: the reply is settled.
    feed.window('s1').settleAssistant('a1' as never, {
      type: 'event',
      event: { type: 'assistant/message', seq: 7, time: 7, data: {} },
    } as never)
    expect(activity.getSnapshot().streaming).toBe(false)
    activity.dispose()
  })

  it('does not read a reasoning chunk as a reply being written', () => {
    // A model working through a problem and a model writing are different poses, and
    // the two arrive on the same feed.
    const feed = sessions()
    const activity = createCompanionActivity(feed.face)
    feed.window('s1').append(chunk(3, 'reasoning-delta'))
    expect(activity.getSnapshot().streaming).toBe(false)

    feed.window('s1').append(chunk(4, 'text-delta'))
    expect(activity.getSnapshot().streaming).toBe(true)
    activity.dispose()
  })

  it('reports a turn start and a failed turn by their own identities', () => {
    const feed = sessions()
    const activity = createCompanionActivity(feed.face)
    expect(activity.getSnapshot().startKey).toBeUndefined()

    feed.window('s1').append(entry('turn/start', 11, { turn: 2 }))
    expect(activity.getSnapshot().startKey).toBe('11')

    feed.window('s1').append(entry('turn/end', 20, { turn: 2, reason: { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } } }))
    expect(activity.getSnapshot().failureKey).toBe('20')
    // A turn that ended well is not a failure, and does not erase the last one.
    feed.window('s1').append(entry('turn/end', 30, { turn: 3, reason: { kind: 'completed' } }))
    expect(activity.getSnapshot().failureKey).toBe('20')
    activity.dispose()
  })

  it('counts an injected message as news and the human prompt as not', () => {
    const feed = sessions()
    const activity = createCompanionActivity(feed.face)
    feed.window('s1').append(entry('user/message', 5, { source: { kind: 'user' } }))
    expect(activity.getSnapshot().noticeKey).toBeUndefined()

    feed.window('s1').append(entry('user/message', 9, { source: { kind: 'plugin', plugin: 'cron' } }))
    expect(activity.getSnapshot().noticeKey).toBe('9')
    activity.dispose()
  })

  it('clears work at a step boundary, where the calls were answered', () => {
    const feed = sessions()
    const activity = createCompanionActivity(feed.face)
    feed.window('s1').append(entry('tool/call', 2, { turn: 1, step: 1 }))
    expect(activity.getSnapshot().toolRunning).toBe(true)
    // A call the step never closed is not work that is still happening.
    feed.window('s1').append(entry('step/end', 3, { turn: 1, step: 1 }))
    expect(activity.getSnapshot().toolRunning).toBe(false)
    activity.dispose()
  })

  it('seeds the continuous facts from a window that already holds a turn', () => {
    // A seat that binds mid-turn has to open on the right phase: the frames it missed
    // are in the window, so they are read back out of it.
    const feed = sessions()
    feed.window('s1').replace([
      entry('turn/start', 1, { turn: 1 }),
      entry('tool/call', 2, { turn: 1, step: 1 }),
      entry('tool/result', 3, { turn: 1, step: 1 }),
      chunk(4, 'text-delta'),
    ], false)
    const activity = createCompanionActivity(feed.face)
    expect(activity.getSnapshot().streaming).toBe(true)
    expect(activity.getSnapshot().toolRunning).toBe(false)
    // But a start that happened before this feed was looking is history, not news:
    // replaying it would open every freshly bound seat on a greeting from an old turn.
    expect(activity.getSnapshot().startKey).toBeUndefined()
    activity.dispose()
  })

  it('follows the shown Session and starts the next one clean', () => {
    const feed = sessions()
    const activity = createCompanionActivity(feed.face)
    feed.window('s1').append(entry('tool/call', 2, { turn: 1, step: 1 }))
    expect(activity.getSnapshot().toolRunning).toBe(true)

    feed.show('s2')
    expect(activity.getSnapshot().toolRunning).toBe(false)
    // And the feed it left is no longer listened to: its events cannot move the pose.
    feed.window('s1').append(entry('turn/start', 9, { turn: 2 }))
    expect(activity.getSnapshot().startKey).toBeUndefined()
    feed.window('s2').append(entry('turn/start', 1, { turn: 1 }))
    expect(activity.getSnapshot().startKey).toBe('1')
    activity.dispose()
  })

  it('publishes only when a fact actually changed, and stops once disposed', () => {
    const feed = sessions()
    const activity = createCompanionActivity(feed.face)
    const listener = vi.fn()
    activity.subscribe(listener)

    // An entry no fact depends on is not a change: the seats read a snapshot their
    // render is keyed on, so every entry would otherwise be a re-render per token.
    feed.window('s1').append(entry('step/start', 1, { turn: 1, step: 1 }))
    expect(listener).not.toHaveBeenCalled()

    feed.window('s1').append(entry('tool/call', 2, { turn: 1, step: 1 }))
    expect(listener).toHaveBeenCalledTimes(1)
    feed.window('s1').append(entry('tool/call', 3, { turn: 1, step: 1 }))
    expect(listener).toHaveBeenCalledTimes(1)

    activity.dispose()
    feed.window('s1').append(entry('tool/result', 4, { turn: 1, step: 1 }))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('reads nothing at all while no Session is shown', () => {
    const feed = sessions(undefined)
    const activity = createCompanionActivity(feed.face)
    expect(feed.window('s1').getSnapshot().entries).toHaveLength(0)
    expect(activity.getSnapshot().toolRunning).toBe(false)
    expect(activity.getSnapshot().startKey).toBeUndefined()
    activity.dispose()
  })
})
