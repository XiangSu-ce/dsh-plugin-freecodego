// @vitest-environment jsdom
/**
 * The companion's transcript seat: the running turn's own status row.
 *
 * Upstream's Chat view draws the loading animation itself — one row of
 * shimmering brand-blue text that rides the whole running turn — and has no slot
 * there, so the seat is an injection (`../src/client/companion/running-row.tsx`).
 * What belongs to this seat, and is asserted here:
 *
 * - the official row keeps its box, its words, and its clock, and loses only the
 *   animation;
 * - the face follows the *facts*, read from the same two stores the slot Hooks are
 *   built over, so the row and the strip above the composer cannot disagree about
 *   what the agent is doing (the case below renders both and compares);
 * - a status row nested inside the transcript is left alone — the seat takes over
 *   the column's own row, not every `role="status"` in the document;
 * - the row's lifetime is the injection's: a turn that ends takes its row with it.
 *
 * The upstream selector is pinned against the upstream source in the last case, so
 * a rename that would silently leave the official animation in place fails here
 * instead of shipping.
 *
 * Frames are pumped by hand and the mocked clock only ever moves forward, for the
 * reason the sibling strip spec gives: the clock is a process singleton, so a
 * counter that restarted per test would read as time running backwards.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
// Imported rather than read off the global: the client ambient `process` is the
// build-time subset (`env` only), so `process.cwd()` is not part of this shape.
import nodeProcess from 'node:process'
import { act, cleanup, render } from '@testing-library/react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionStatus } from '@deepseek-ai/dsh-client-ui-session/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CompanionBar } from '../src/client/companion/bar.tsx'
import { zh, type CompanionKey } from '../src/client/companion/companion-locale.ts'
import { runningRowHasFace } from '../src/client/companion/running-row-presence.ts'
import { activityFixture, type ActivityFixture } from './companion-activity.fixture.ts'
import {
  RUNNING_ROW_ATTR,
  RUNNING_ROW_FACE_ATTR,
  RUNNING_ROW_FACE_PX,
  RUNNING_ROW_SELECTOR,
  installRunningRow,
} from '../src/client/companion/running-row.tsx'

/** Monotonic for the whole file, for the reason in the header. */
let clockMs = 0
/** Frames queued by the stub `requestAnimationFrame`, drained by {@link pump}. */
let pendingFrames: FrameRequestCallback[] = []

vi.spyOn(performance, 'now').mockImplementation(() => clockMs)

beforeEach(() => {
  clockMs = 0
  pendingFrames = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    pendingFrames.push(callback)
    return pendingFrames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => { pendingFrames.length = 0 })
})

afterEach(() => {
  for (const dispose of installed.splice(0)) dispose()
  cleanup()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  document.head.querySelectorAll('[data-fcg-running-row-style]').forEach(tag => { tag.remove() })
})

/**
 * Every injection a case installed, disposed after it.
 *
 * The seat watches the whole document and the clock is a process singleton, so a
 * test that left its injection running would keep mounting faces into the next
 * test's fixture and keep publishing on the next test's clock — which is how one
 * stale root makes a later assertion read the wrong pose.
 */
let installed: (() => void)[] = []

/**
 * Advance the clock and run the frames queued for it, as an animation loop would.
 *
 * The injection's own scan is scheduled on a frame; the React root it mounts is
 * *not* — a root rendered outside a React tree commits on the scheduler's own
 * turn — so a pass also has to let that commit land before anything is asserted.
 */
async function pump(advanceMs = 16): Promise<void> {
  clockMs += advanceMs
  await act(async () => {
    for (const callback of pendingFrames.splice(0)) callback(clockMs)
  })
}

/** One session's row, as the readers see it. */
interface Row {
  running: boolean
  jobs: readonly { id: string; status: string }[]
  retained: number
}

/** The Session list snapshot the readers consume. */
interface SessionsState {
  ids: string[]
  byId: Record<string, { id: string; running: boolean; retainedBy: { mainView?: number } }>
  jobsBySession: Record<string, readonly { id: string; status: string }[]>
}

/** Build a Session list snapshot out of the rows under test. */
function sessionsState(rows: Record<string, Row>): SessionsState {
  const state: SessionsState = { ids: [], byId: {}, jobsBySession: {} }
  for (const [id, row] of Object.entries(rows)) {
    state.ids.push(id)
    state.byId[id] = { id, running: row.running, retainedBy: { mainView: row.retained } }
    state.jobsBySession[id] = row.jobs
  }
  return state
}

/** The status rows the seat's second source carries. */
type StatusesState = ReadonlyMap<string, SessionStatus>

/** A snapshot source the test pushes into, shaped like `ObservableSnapshot`. */
function source<T>(initial: T): {
  source: { getSnapshot: () => T; subscribe: (listener: () => void) => () => void }
  set: (value: T) => void
} {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    source: {
      getSnapshot: () => value,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    set: (next: T) => {
      value = next
      act(() => { for (const listener of [...listeners]) listener() })
    },
  }
}

/** The two sources, plus the fake context the seat is installed into. */
function sources(rows: Record<string, Row>, statuses: StatusesState = new Map()) {
  const sessions = source(sessionsState(rows))
  const sessionStatus = source(statuses)
  const context = {
    sessions: { list: sessions.source },
    uiSession: { sessionStatus: sessionStatus.source },
  } as unknown as ClientContext
  return { sessions, sessionStatus, context }
}

/** The upstream column, with the official row in it and a nested status row. */
const COLUMN = `
  <div data-chat-flow="">
    <div class="row"><div role="status" aria-live="polite">本轮运行失败</div></div>
    <div role="status" aria-live="polite">深度求索中...<span aria-hidden="true">0:42</span></div>
  </div>
`

/** @returns the upstream row the seat is expected to take over. */
function officialRow(): HTMLElement {
  return document.querySelectorAll<HTMLElement>(RUNNING_ROW_SELECTOR)[0]!
}

/** @returns the container the face is mounted into, if the row was taken over. */
function face(row: HTMLElement): HTMLElement | null {
  return row.querySelector<HTMLElement>(`[${RUNNING_ROW_FACE_ATTR}]`)
}

/** @returns the pose the injected face is drawing, from its published state. */
function injectedPose(): string | null {
  return face(officialRow())?.querySelector('svg')?.getAttribute('data-fcg-state') ?? null
}

/**
 * Render the strip seat over the same stores the injected row reads.
 *
 * The strip is handed its session by the dock entry and its facts by the slot
 * Hooks, which is what the stubs here stand in for — so a case can compare the two
 * seats' poses without a slot system.
 * @param facts - the two stores.
 * @param activity - the live feed both seats read.
 * @returns the rendered strip.
 */
function renderStrip(facts: ReturnType<typeof sources>, activity: ActivityFixture) {
  const snapshot = facts.sessions.source.getSnapshot()
  return render(
    <CompanionBar
      {...{
        session: { sessionId: 's1', running: true, blank: false },
        input: {},
        useSessions: (selector: (state: SessionsState) => unknown) => selector(snapshot),
        useSessionStatus: (selector: (map: StatusesState) => unknown) => selector(facts.sessionStatus.source.getSnapshot()),
        activity,
        t: (key: CompanionKey) => zh[key],
      } as unknown as Parameters<typeof CompanionBar>[0]}
    />,
  )
}

/** @returns the pose the strip is drawing, or null while the row holds it. */
function stripPose(strip: ReturnType<typeof renderStrip>): string | null {
  return strip.container.querySelector('svg')?.getAttribute('data-fcg-state') ?? null
}

/**
 * @returns the pose the strip has *decided*, whether or not it is drawing it.
 *
 * The two are not the same while the transcript's row holds the drawing: the strip
 * yields the character and keeps its decision, which is the half of "cannot
 * disagree" that survives the handover.
 */
function stripState(strip: ReturnType<typeof renderStrip>): string | null {
  return strip.container.querySelector('[data-fcg-companion="bar"]')?.getAttribute('data-fcg-companion-state') ?? null
}

/** Facts for a running session. */
const RUNNING: Record<string, Row> = { s1: { running: true, jobs: [], retained: 1 } }

/**
 * Install the seat against a fake context over the given facts.
 * @param facts - the two stores the seat reads.
 * @param activity - the live feed; a case that asserts agreement passes the seat
 * and the strip one instance, exactly as the plugin installs them.
 * @returns the seat's disposer.
 */
function install(facts: ReturnType<typeof sources>, activity = activityFixture()): () => void {
  return installRunningRow(facts.context, activity)
}

/** A pending user interaction, which is the only status fact the readers need. */
function pending(): StatusesState {
  // The interaction's own identity is opaque here beyond being present, so the
  // fixture spells it once and the branded session id comes with the type.
  const interaction = { key: 'k', kind: 'ask', sessionId: 's1' } as SessionStatus['pendingInteraction']
  return new Map([['s1', { running: true, pendingInteraction: interaction, completionUnread: false }]])
}

async function setup(
  facts: ReturnType<typeof sources>,
  activity = activityFixture(),
): Promise<{ dispose: () => void }> {
  document.body.innerHTML = COLUMN
  const dispose = install(facts, activity)
  installed.push(dispose)
  await pump()
  return { dispose }
}

describe('companion running row: taking over the official loading row', () => {
  it('keeps the row, its words, and its clock, and loses only the animation', async () => {
    await setup(sources(RUNNING))
    const row = officialRow()
    expect(row.getAttribute(RUNNING_ROW_ATTR)).toBe('true')
    const container = face(row)
    expect(container).not.toBeNull()
    // First child, so the clock React may append later lands after the face.
    expect(row.firstElementChild).toBe(container)
    expect(container!.querySelector('svg')?.getAttribute('width')).toBe(String(RUNNING_ROW_FACE_PX))
    // The official row's own content survives: the announcement for a reader who
    // cannot see the face, and the elapsed clock for one who can.
    expect(row.textContent).toContain('深度求索中')
    expect(row.textContent).toContain('0:42')
  })

  it('mounts one face per row however many scans run', async () => {
    await setup(sources(RUNNING))
    await pump()
    await pump()
    const row = officialRow()
    expect(row.querySelectorAll(`[${RUNNING_ROW_FACE_ATTR}]`)).toHaveLength(1)
    expect(row.querySelectorAll('svg')).toHaveLength(1)
  })

  it('draws the animation-removal rule against the row it marked', async () => {
    await setup(sources(RUNNING))
    const sheet = document.head.querySelector<HTMLStyleElement>('[data-fcg-running-row-style]')
    expect(sheet).not.toBeNull()
    const css = sheet!.textContent ?? ''
    // Every one of these is what stands between the row and the shimmer: the
    // gradient's paint, its sweep, and the label's width.
    expect(css).toContain('[data-fcg-companion-row]')
    expect(css).toContain('background: none !important')
    expect(css).toContain('animation: none !important')
    expect(css).toContain('-webkit-text-fill-color: transparent !important')
    expect(css).toContain('font-size: 0 !important')
  })

  it('leaves a status row nested in the transcript alone', async () => {
    await setup(sources(RUNNING))
    const nested = document.querySelector<HTMLElement>('.row > [role="status"]')
    expect(nested!.getAttribute(RUNNING_ROW_ATTR)).toBeNull()
    expect(face(nested!)).toBeNull()
  })

  it('unmounts with the row it took over', async () => {
    const { dispose } = await setup(sources(RUNNING))
    const row = officialRow()
    expect(face(row)).not.toBeNull()
    act(() => { row.remove() })
    await pump()
    // The container is released with the row, so nothing keeps drawing for it, and
    // the claim it held on the character goes with it.
    expect(face(row)).toBeNull()
    expect(runningRowHasFace()).toBe(false)
    dispose()
  })
})

describe('companion running row: the fact the two surfaces cannot disagree about', () => {
  it('follows the session facts, not the row it was injected into', async () => {
    const facts = sources(RUNNING)
    await setup(facts)
    // A running turn with nothing else true is the arbiter's `thinking`.
    expect(injectedPose()).toBe('thinking')
    // A pose is published on the shared clock's tick, which is also what makes a
    // fact change visible at all: the seats work the same way.
    facts.sessionStatus.set(pending())
    await pump()
    expect(injectedPose()).toBe('alert')
    facts.sessionStatus.set(new Map())
    facts.sessions.set(sessionsState({ s1: { running: true, jobs: [{ id: 'j1', status: 'running' }], retained: 1 } }))
    await pump()
    // `orbit` is less urgent than the alert it would replace, so the arbiters'
    // dwell floor holds the alert — the same floor the seats obey, because this
    // is the same arbiter.
    expect(injectedPose()).toBe('alert')
    await pump(2100)
    expect(injectedPose()).toBe('orbit')
  })

  it('reports the strip\u2019s own pose, and holds the drawing while the row is up', async () => {
    const facts = sources(RUNNING)
    // One feed for both seats, as the plugin installs them: the property under test
    // is that the row and the strip cannot disagree, and a second feed would let them.
    const activity = activityFixture()
    await setup(facts, activity)
    // The strip, rendered from the slot Hooks the framework builds over these
    // same two sources, for the session the main view retains.
    const strip = renderStrip(facts, activity)
    const stripBar = (): Element => strip.container.querySelector('[data-fcg-companion="bar"]')!
    // One character, one pose: the row draws what the stats behind the strip say.
    expect(injectedPose()).toBe(stripBar().getAttribute('data-fcg-companion-state'))
    expect(injectedPose()).toBe('thinking')
    // And one copy: while the row holds it, the strip reports the handover and
    // draws no face of its own.
    expect(runningRowHasFace()).toBe(true)
    expect(stripBar().getAttribute('data-fcg-companion-face')).toBe('transcript')
    expect(strip.container.querySelector('svg')).toBeNull()

    // The turn ends and the row goes with it, so the strip takes the drawing back —
    // the same pose, from the same facts, at the end of the transcript the reader
    // has just finished watching.
    act(() => { officialRow().remove() })
    await pump()
    expect(runningRowHasFace()).toBe(false)
    expect(stripBar().getAttribute('data-fcg-companion-face')).toBe('composer')
    expect(stripPose(strip)).toBe('thinking')
  })

  it('shows the same phase in both seats while the reply streams', async () => {
    // The two facts the event feed adds are the ones the list cannot separate: the
    // reply being written, and a tool call in flight. One feed, one phase, in both
    // places the character is drawn — the row at the end of the transcript and the
    // strip above the composer.
    const facts = sources(RUNNING)
    const activity = activityFixture()
    await setup(facts, activity)
    const strip = renderStrip(facts, activity)
    expect(injectedPose()).toBe('thinking')

    act(() => { activity.publish({ streaming: true }) })
    await pump()
    expect(injectedPose()).toBe('comet')
    expect(stripState(strip)).toBe('comet')

    act(() => { activity.publish({ streaming: false, toolRunning: true }) })
    await pump()
    expect(injectedPose()).toBe('orbit')
    expect(stripState(strip)).toBe('orbit')
  })
})

describe('companion running row: the upstream row this was read from', () => {
  it('still renders a direct child of the chat column that announces itself as one', () => {
    // The seat's whole reach is this selector, and upstream owns both halves of
    // it. Read from the synced source rather than from a copy of it, so an
    // upstream change fails here rather than at runtime with the official
    // animation quietly still running.
    const root = resolve(nodeProcess.cwd(), 'packages/client/ui-chat/src/client/chat/ChatView.tsx')
    const source = readFileSync(root, 'utf8')
    expect(source).toContain('data-chat-flow=""')
    expect(source).toContain('<div className={css.turnStatus} role="status" aria-live="polite">')
  })
})
