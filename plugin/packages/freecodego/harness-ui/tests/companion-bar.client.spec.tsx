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
import { en, zh, type CompanionKey } from '../src/client/companion/companion-locale.ts'
import { STATE_BY_ID } from '../src/client/companion/engine/states.ts'

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
 * The session facts the seat reads through the global standard kit.
 *
 * No `current`: the strip is handed its own session by the dock entry, so it
 * never asks which one is open — and alpha.2 removed the field anyway.
 */
interface SessionsState {
  byId: Record<string, { running: boolean }>
  jobsBySession: Record<string, readonly { status: string }[]>
}

/** A session that is producing a turn, or one that has come to rest. */
const running = (value: boolean): SessionsState => ({
  byId: { s1: { running: value } },
  jobsBySession: {},
})

/** The component's own props type, so the stubs cannot drift from the seat. */
type BarProps = Parameters<typeof CompanionBar>[0]

/**
 * Stub the dock entry's runtime props.
 *
 * The pose facts come from the shared kit rather than from the owner share, which
 * is the property being relied on: the row's `session` names the session it was
 * rendered for, and the facts behind the pose are the ones the rail mark reads too.
 * The label is the real Chinese dictionary, so the row's words are asserted
 * against the namespace rather than against a stub.
 */
function stubProps(sessions: SessionsState): BarProps {
  return {
    session: { sessionId: 's1', running: false, blank: false },
    input: {},
    useSessions: (selector: (state: SessionsState) => unknown) => selector(sessions),
    // Presence is all the row reads, so the empty status snapshot is the fixture.
    useSessionStatus: (selector: (map: ReadonlyMap<string, SessionStatus>) => unknown) => selector(new Map()),
    t: (key: CompanionKey) => zh[key],
  } as unknown as BarProps
}

/** Render the strip against stub props. */
function setup(sessions: SessionsState) {
  return render(<CompanionBar {...stubProps(sessions)} />)
}

/** Re-render the same seat with different facts, as a session update would. */
function update(view: ReturnType<typeof setup>, sessions: SessionsState): void {
  view.rerender(<CompanionBar {...stubProps(sessions)} />)
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
  it('is on screen before anything happens, drawn quiet', () => {
    const { container } = setup(running(false))
    pump()
    expect(bar(container)).not.toBeNull()
    expect(resting(container)).toBe('true')
    expect(pose(container)).toBe('idle')
    expect(bar(container)!.textContent).toBe('空闲')
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
    // The resting look is a fade on the same row, not a second element.
    expect(stylesheet).toContain(".root[data-fcg-companion-rest='true']")
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
