// @vitest-environment jsdom
/**
 * The companion's composer seat.
 *
 * The rail mark's slot hands its occupant a fixed 24px, so the strip above the
 * composer is the only place the character can be drawn at size. What belongs to
 * *this* seat is what is tested here: it sizes itself from the column it is laid
 * out in, it holds one lane height for the whole session so nothing it shows can
 * move the composer, and it names the pose in the reader's language. Everything
 * else it shows comes from the shared half, which `./companion.client.spec.tsx`
 * covers through the other seat.
 *
 * The no-movement property is the one worth stating twice: a strip that mounted
 * and unmounted with the work would shift the composer stack by its own height
 * twice per turn, so the assertions below walk a whole turn — rest, thinking,
 * celebrating, rest — and require the drawing to be the same size at every step,
 * in the same row, with the observation started once and never restarted.
 *
 * Frames are pumped by hand and the mocked clock only ever moves forward, for the
 * reason the sibling spec gives: the clock is a process singleton, so a counter
 * that restarted per test would read as time running backwards.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
// Imported rather than read off the global: the client ambient `process` is the
// build-time subset (`env` only), so `process.cwd()` is not part of this shape.
import nodeProcess from 'node:process'
import { act, cleanup, render } from '@testing-library/react'
import type { SessionStatus } from '@deepseek-ai/dsh-client-ui-session/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COMPANION_MAX_PX,
  COMPANION_MIN_PX,
  CompanionBar,
  companionAtRest,
  companionSize,
} from '../src/client/companion/bar.tsx'
import { FLOURISHES } from '../src/client/companion/arbiter.ts'
import { companionClock } from '../src/client/companion/driver.ts'
import { FLOURISH_PERIOD_MS, FLOURISH_WINDOW_MS } from '../src/client/companion/signals.ts'
import { en, zh, type CompanionKey } from '../src/client/companion/companion-locale.ts'
import { claimRunningRowFace, runningRowHasFace } from '../src/client/companion/running-row-presence.ts'
import { STATE_BY_ID } from '../src/client/companion/engine/states.ts'
import { activityFixture } from './companion-activity.fixture.ts'

/** Monotonic for the whole file, for the reason in the header. */
let clockMs = 0
/** Frames queued by the stub `requestAnimationFrame`, drained by {@link pump}. */
let pendingFrames: FrameRequestCallback[] = []
/** The single observation the seat is expected to have started. */
let observed: { node: Element; deliver: (entries: unknown[]) => void } | undefined
/** How many observations were started, and how many were ended. */
let observes = 0
let disconnects = 0

vi.spyOn(performance, 'now').mockImplementation(() => clockMs)

/** A `ResizeObserver` the test drives by hand. */
class FakeResizeObserver {
  private readonly callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }

  observe(node: Element): void {
    observes += 1
    observed = {
      node,
      deliver: (entries: unknown[]) => {
        act(() => { this.callback(entries as never, this as never) })
      },
    }
  }

  disconnect(): void {
    disconnects += 1
  }
}

beforeEach(() => {
  clockMs = 0
  pendingFrames = []
  observed = undefined
  observes = 0
  disconnects = 0
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    pendingFrames.push(callback)
    return pendingFrames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => { pendingFrames.length = 0 })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Advance the clock and run the frames queued for it, as an animation loop would. */
function pump(advanceMs = 16): void {
  clockMs += advanceMs
  act(() => {
    for (const callback of pendingFrames.splice(0)) callback(clockMs)
  })
}

/**
 * The shared clock's own reading, in milliseconds.
 *
 * The animation clock is a process singleton that only ever moves forward, so a test
 * cannot assume a phase: it asks the clock where the next resting window is. The
 * mocked frame clock above is reset per test; this one is not, and is the one the
 * seat decides from.
 * @returns the shared clock's reading in milliseconds.
 */
function sharedNowMs(): number {
  return companionClock().nowSeconds() * 1000
}

/**
 * The next instant inside a resting window, at or after `atMs`.
 *
 * 100 ms into the period, because a window is half-open: it opens on the period's
 * boundary and is closed again by its far edge.
 * @param atMs - the earliest instant worth opening a window at.
 * @returns that instant in milliseconds.
 */
function windowAtOrAfter(atMs: number): number {
  return Math.ceil((atMs + 1) / FLOURISH_PERIOD_MS) * FLOURISH_PERIOD_MS + 100
}

/**
 * The session facts the seat reads through the global standard kit.
 *
 * No `current`: the strip is handed its own session by the dock entry, so it
 * never asks which one is open — and alpha.2 removed the field anyway.
 */
interface SessionsState {
  byId: Record<string, { running: boolean }>
}

/** A session that is producing a turn, or one that has come to rest. */
const running = (value: boolean): SessionsState => ({
  byId: { s1: { running: value } },
})

/** The component's own props type, so the stubs cannot drift from the seat. */
type BarProps = Parameters<typeof CompanionBar>[0]

/**
 * The jobs snapshot the seat reads through the hook its entry binds.
 *
 * Derived from the seat's own hook, like the other fixtures in this suite, so a
 * rename in the jobs contract surfaces here instead of leaving a stale stub.
 */
type JobsState = Parameters<Parameters<BarProps['useJobs']>[0]>[0]

/** No roster and no observation: every case here is about turn facts. */
const noJobs: JobsState = { rows: {}, observed: {} }

/**
 * Stub the dock entry's runtime props.
 *
 * The pose facts come from the shared kit rather than from the owner share, which
 * is the property being relied on: the row's `session` names the session it was
 * rendered for, and the facts behind the pose are the ones the rail mark reads too.
 * The label is the real Chinese dictionary, so the row's words are asserted
 * against the namespace rather than against a stub.
 */
/**
 * Stub the dock entry's runtime props.
 *
 * `blank` is the framework's own reading of the blank-session Hero, and the seat
 * gives it one meaning: no strip at all. Defaulted to `false` because every case
 * below that is not about the Hero is about a session that already has a turn.
 */
function stubProps(sessions: SessionsState, blank = false, activity = activityFixture()): BarProps {
  return {
    session: { sessionId: 's1', running: false, blank },
    input: {},
    useSessions: (selector: (state: SessionsState) => unknown) => selector(sessions),
    // Presence is all the row reads, so the empty status snapshot is the fixture.
    useSessionStatus: (selector: (map: ReadonlyMap<string, SessionStatus>) => unknown) => selector(new Map()),
    // A job roster reaches the seat through its entry's `hooks` compartment rather
    // than the standard kit; no case here drives one, so it stays empty.
    useJobs: (selector: (roster: JobsState) => unknown) => selector(noJobs),
    // The live feed arrives by injection rather than through a store, which is why
    // the seat's props carry it: the two slot seats have no context to read one from.
    activity,
    t: (key: CompanionKey) => zh[key],
  } as unknown as BarProps
}

/**
 * Render the strip against stub props.
 * @param sessions - the session list snapshot the row reads.
 * @param blank - the framework's blank-session Hero bit.
 * @param activity - the live feed, when the case drives one.
 * @returns the rendered seat.
 */
function setup(sessions: SessionsState, blank = false, activity = activityFixture()) {
  return render(<CompanionBar {...stubProps(sessions, blank, activity)} />)
}

/** Re-render the same seat with different facts, as a session update would. */
function update(view: ReturnType<typeof setup>, sessions: SessionsState, blank = false): void {
  view.rerender(<CompanionBar {...stubProps(sessions, blank)} />)
}

/** @returns the strip element. */
function bar(container: HTMLElement): Element | null {
  return container.querySelector('[data-fcg-companion="bar"]')
}

/** @returns the drawing's edge as rendered. */
function drawnAt(container: HTMLElement): string | null {
  return container.querySelector('svg')!.getAttribute('width')
}

/** @returns the pose the strip is showing. */
function pose(container: HTMLElement): string | null {
  return bar(container)!.getAttribute('data-fcg-companion-state')
}

/** @returns whether the strip is drawing in its resting look. */
function resting(container: HTMLElement): string | null {
  return bar(container)!.getAttribute('data-fcg-companion-rest')
}

/** @returns which surface the strip says is holding the drawing. */
function face(container: HTMLElement): string | null {
  return bar(container)!.getAttribute('data-fcg-companion-face')
}

describe('companion strip: how large the character is drawn', () => {
  it('draws at the floor before it has measured anything', () => {
    expect(companionSize(0)).toBe(COMPANION_MIN_PX)
  })

  it('takes a share of the column it is laid out in', () => {
    // 700px is a typical conversation column, and one fourteenth of it is 50px.
    expect(companionSize(700)).toBe(50)
    // Proportional, so a wider panel draws a larger character rather than the same one.
    expect(companionSize(1000)).toBeGreaterThan(companionSize(700))
  })

  it('stops at a floor and a ceiling', () => {
    expect(companionSize(14)).toBe(COMPANION_MIN_PX)
    expect(companionSize(100_000)).toBe(COMPANION_MAX_PX)
  })
})

describe('companion strip: one lane height, for the whole session', () => {
  it('is on screen at rest inside a conversation', () => {
    const { container } = setup(running(false))
    pump()
    expect(bar(container)).not.toBeNull()
    expect(resting(container)).toBe('true')
    expect(pose(container)).toBe('idle')
    expect(bar(container)!.textContent).toBe('空闲')
  })

  it('draws nothing at all on the blank-session Hero', () => {
    // The new-conversation page has no conversation to describe yet, and the strip
    // there was the first thing a user saw above an empty composer: a status line
    // named "idle" for work nobody has asked for. Nothing of the seat is drawn — not
    // a label, not a lane, not even the character at rest — because a hidden row that
    // still occupied its height would be the same wasted space with less to read.
    const { container } = setup(running(false), true)
    pump()
    expect(bar(container)).toBeNull()
    expect(container.querySelector('svg')).toBeNull()
    expect(container.textContent).toBe('')
    // And it did not measure a lane it is not drawing in: the observation starts
    // when there is a lane to measure, which is also what keeps the blank page from
    // holding a subscription it will never use.
    expect(observes).toBe(0)
  })

  it('appears on the first prompt and measures its lane then', () => {
    // The transition the Hero guard has to survive: same seat instance, `blank`
    // clearing on the first send. The lane is measured at that point (not before),
    // and from there it is the strip the rest of this file describes — one lane, one
    // pose at a time, never leaving again while the conversation is on screen.
    const view = setup(running(false), true)
    pump()
    expect(bar(view.container)).toBeNull()
    expect(observes).toBe(0)

    update(view, running(true), false)
    pump()
    expect(bar(view.container)).not.toBeNull()
    expect(pose(view.container)).toBe('thinking')
    expect(observes).toBe(1)
    const firstSize = drawnAt(view.container)

    update(view, running(false), false)
    pump(700)
    pump(2_500)
    expect(pose(view.container)).toBe('idle')
    expect(bar(view.container)).not.toBeNull()
    expect(drawnAt(view.container)).toBe(firstSize)
    // «Back to the Hero» is not a state a session returns to: the bit is monotone,
    // so the lane that has appeared stays for the session.
    expect(observes).toBe(1)
  })

  it('takes the lane out of its resting look while there is something to say', () => {
    const { container } = setup(running(true))
    pump()
    expect(resting(container)).toBe('false')
    expect(pose(container)).toBe('thinking')
    expect(bar(container)!.textContent).toBe('思考中')
    expect(bar(container)!.getAttribute('role')).toBe('status')
  })

  it('holds the drawing at one size through a whole turn, without ever leaving', () => {
    const sessions = running(false)
    const view = setup(sessions)
    pump()
    const restingSize = drawnAt(view.container)

    // A turn begins: the pose changes, the drawing does not move.
    update(view, running(true))
    pump(700)
    expect(pose(view.container)).toBe('thinking')
    expect(drawnAt(view.container)).toBe(restingSize)

    // The turn ends: the celebration plays, and still nothing moves.
    update(view, running(false))
    pump(700)
    expect(pose(view.container)).toBe('burst')
    expect(drawnAt(view.container)).toBe(restingSize)

    // And the rest that follows draws quiet in the same row rather than taking it away.
    pump(2_500)
    expect(pose(view.container)).toBe('idle')
    expect(resting(view.container)).toBe('true')
    expect(drawnAt(view.container)).toBe(restingSize)
    expect(view.container.querySelector('svg')).not.toBeNull()
  })

  it('keeps a lane at least as tall as the largest character', () => {
    // The stylesheet is the other half of the sizing policy, and the two have to
    // agree: a lane shorter than the largest drawing is a row that resizes, which
    // is the failure this seat exists to avoid.
    // Read from the repository root vitest runs in; `import.meta.url` is served by
    // the test transform rather than read from disk, so it cannot locate the file.
    const stylesheet = readFileSync(
      resolve(nodeProcess.cwd(), 'packages/freecodego/harness-ui/src/client/companion/companion.module.css'),
      'utf8',
    )
    const lane = /\.root \{[\s\S]*?min-height:\s*(\d+)px/.exec(stylesheet)
    expect(lane).not.toBeNull()
    expect(Number(lane![1])).toBeGreaterThanOrEqual(COMPANION_MAX_PX)
  })

  it('draws the character at full ink in every pose, resting included', async () => {
    // The row used to fade to 40% for `idle` and `sleep`, which on a light surface
    // is a grey character and on a dark one a washed-out one — and `idle` is where a
    // session spends most of its time, so the character was least legible in its most
    // common state. Pinned as a stylesheet reading because the property is a *look*
    // rather than behaviour: the pose and the label already say "nothing is
    // happening", and the draw-in was the only thing making the row hard to read.
    const stylesheet = readFileSync(
      resolve(nodeProcess.cwd(), 'packages/freecodego/harness-ui/src/client/companion/companion.module.css'),
      'utf8',
    )
    const restingRule = /\[data-fcg-companion-rest='true'\]\s*\{([^}]*)\}/u.exec(stylesheet)
    // The attribute may be styled by a host, so the rule itself is allowed — what is
    // not allowed is it drawing the row back.
    expect(restingRule?.[1] ?? '').not.toMatch(/opacity|filter|color/u)
    // And the row never fades as a whole, resting or not.
    const rootRule = /\.root \{([^}]*)\}/u.exec(stylesheet)
    expect(rootRule?.[1] ?? '').not.toMatch(/opacity:\s*0\./u)
  })
})

describe('companion strip: handing the character to the transcript', () => {
  it('yields the drawing while the running row holds it, and keeps its lane and words', () => {
    const { container } = setup(running(true))
    pump()
    expect(face(container)).toBe('composer')
    const drawnSize = drawnAt(container)

    let release: (() => void) | undefined
    act(() => { release = claimRunningRowFace() })

    // The drawing is gone from this row and nothing else is: the lane element is
    // still here — its height is the stylesheet's job, pinned above — and the words
    // that say what the agent is doing are still the row's own.
    expect(face(container)).toBe('transcript')
    expect(container.querySelector('svg')).toBeNull()
    expect(bar(container)).not.toBeNull()
    expect(bar(container)!.textContent).toBe('思考中')
    expect(pose(container)).toBe('thinking')

    act(() => { release?.() })
    expect(face(container)).toBe('composer')
    expect(drawnAt(container)).toBe(drawnSize)
    expect(runningRowHasFace()).toBe(false)
  })

  it('yields while any claim stands, and takes the drawing back when the last one goes', () => {
    // A claim is owned by a mount, so two rows overlapping in one frame cannot
    // drop the character: whichever is released first, one claim is still standing.
    const { container } = setup(running(true))
    pump()
    let first: (() => void) | undefined
    let second: (() => void) | undefined
    act(() => {
      first = claimRunningRowFace()
      second = claimRunningRowFace()
    })
    expect(face(container)).toBe('transcript')
    act(() => { first?.() })
    expect(face(container)).toBe('transcript')
    act(() => { second?.() })
    expect(face(container)).toBe('composer')
    expect(runningRowHasFace()).toBe(false)
  })
})

describe('companion strip: the resting character keeps moving', () => {
  it('plays the resting catalogue one pose per period, and not the same pose forever', () => {
    // A session waiting for its next prompt is where the mark is seen most, and one
    // that never moved there reads as broken rather than as calm. So the quiet poses
    // are interrupted by a short flourish from the engine's catalogue on a period,
    // and this walks two consecutive periods: the first pose is not the only pose,
    // which is the defect it pins. Which pose a period plays is read from the shared
    // clock, so every seat plays the same rotation rather than each walking the
    // catalogue from whenever it mounted.
    const { container } = setup(running(false))
    pump()
    expect(pose(container)).toBe('idle')

    // The first window in which the seat has both rested a whole period of its own
    // and is inside one of the clock's windows.
    const startMs = sharedNowMs()
    const firstAt = windowAtOrAfter(startMs + FLOURISH_PERIOD_MS)
    pump(firstAt - startMs)
    const played = pose(container)
    expect(FLOURISHES).toContain(played)
    // The words follow the pose, out of the same dictionary the rail seat reads: a
    // flourish is drawn by a session doing nothing, so it is named as the gesture it
    // is rather than as a status that would contradict the session on screen.
    expect(FLOURISHES.map(id => zh[id])).toContain(bar(container)!.textContent)

    // The window closes and the character returns to rest, so the catalogue is a
    // succession of poses rather than one pose held from the moment it first played.
    pump(FLOURISH_WINDOW_MS + 100)
    expect(pose(container)).toBe('idle')

    // The next period, one window later on the same grid, offers the next pose.
    pump(firstAt + FLOURISH_PERIOD_MS - sharedNowMs())
    expect(FLOURISHES).toContain(pose(container))
    expect(pose(container)).not.toBe(played)
  })
})

describe('companion strip: which poses draw quiet', () => {
  it('counts only the engine\u2019s two quiet ends as rest', () => {
    // Table-driven on purpose: a state the engine gains is treated as work unless it
    // is genuinely one of the resting poses, rather than silently falling out of the row.
    const quiet = [...STATE_BY_ID.keys()].filter(stateId => companionAtRest(stateId))
    expect(quiet.sort()).toEqual(['idle', 'sleep'])
  })
})

describe('companion strip: measuring its own column', () => {
  it('takes the observer\u2019s width, and the drawing follows it', () => {
    const { container } = setup(running(true))
    pump()
    expect(drawnAt(container)).toBe(String(COMPANION_MIN_PX))
    expect(observed).toBeDefined()
    observed!.deliver([{ contentRect: { width: 900 } }])
    expect(drawnAt(container)).toBe(String(companionSize(900)))
    // A resize is followed, not just the first report.
    observed!.deliver([{ contentRect: { width: 280 } }])
    expect(drawnAt(container)).toBe(String(companionSize(280)))
  })

  it('measures the element it was given', () => {
    const { container } = setup(running(true))
    pump()
    expect(observed!.node).toBe(bar(container))
  })

  it('keeps the last width when a report carries no measurement', () => {
    const { container } = setup(running(true))
    pump()
    observed!.deliver([{ contentRect: { width: 500 } }])
    const settled = drawnAt(container)
    // An empty batch carries no measurement; it must not reset the row to the floor.
    observed!.deliver([])
    expect(drawnAt(container)).toBe(settled)
  })

  it('starts one observation per mount and leaves it alone across poses', () => {
    const sessions = running(false)
    const view = setup(sessions)
    pump()
    update(view, running(true))
    pump(700)
    pump(2_500)
    // A pose change is not a remount: the lane is measured once and kept.
    expect(observes).toBe(1)
    expect(disconnects).toBe(0)
    expect(bar(view.container)).not.toBeNull()
  })

  it('ends the observation when the seat itself goes away', () => {
    const view = setup(running(true))
    pump()
    expect(disconnects).toBe(0)
    view.unmount()
    expect(disconnects).toBe(1)
  })

  it('draws at the floor in a realm with no ResizeObserver at all', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const { container } = setup(running(true))
    pump()
    expect(bar(container)).not.toBeNull()
    expect(drawnAt(container)).toBe(String(COMPANION_MIN_PX))
    // A removal in that realm has no observation to end, which is not an error.
    cleanup()
    expect(disconnects).toBe(0)
  })
})

describe('companion strip: the label reads in the reader\u2019s language', () => {
  it('names every state the engine declares, in both languages', () => {
    // The dictionary is keyed by the engine's own state ids, so this is the drift
    // guard for a state the vendored engine gains: the type stops compiling and
    // this stops passing, rather than a pose drawing with no words for it.
    const states = [...STATE_BY_ID.keys()].sort()
    expect(Object.keys(zh).sort()).toEqual(states)
    expect(Object.keys(en).sort()).toEqual(states)
    for (const key of states) {
      expect(zh[key]).not.toBe('')
      expect(en[key]).not.toBe('')
    }
  })
})
