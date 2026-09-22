// @vitest-environment jsdom
/**
 * The companion's browser half: one frame drawn as SVG, and the wiring that turns
 * session facts into the state that frame comes from.
 *
 * The renderer is tested against hand-built frames rather than engine output, so
 * the cases the engine rarely produces — a single-stop gradient, one eye instead
 * of two, a particle with a shaped path — are reachable at all. The component is
 * tested against stub standard-prop hooks, which is what its props already are:
 * plain functions, so no render machinery is needed to drive it.
 *
 * Frames are pumped by hand rather than by a real animation loop, and the mocked
 * clock only ever moves forward: the clock itself is a process singleton, so a
 * counter that restarted per test would read as time running backwards.
 */

import { act, cleanup, render } from '@testing-library/react'
import type { SessionStatus } from '@deepseek-ai/dsh-client-ui-session/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CompanionSvg, dotFill } from '../src/client/companion/render.tsx'
import { FreeCodeGoCompanion, installCompanion } from '../src/client/companion/companion.tsx'
import { BotEngine } from '../src/client/companion/engine/engine.ts'
import { RAYON } from '../src/client/companion/engine/repere.ts'
import { SHAPES } from '../src/client/companion/engine/skins.ts'
import { STATE_BY_ID } from '../src/client/companion/engine/states.ts'
import { en, zh } from '../src/client/companion/companion-locale.ts'
import { IDLE_AFTER_MS } from '../src/client/companion/signals.ts'
import { activityFixture } from './companion-activity.fixture.ts'
import type { BotFrame } from '../src/client/companion/engine/engine.ts'

/** Monotonic for the whole file, for the reason in the header. */
let clockMs = 0
/** Frames queued by the stub `requestAnimationFrame`, drained by {@link pump}. */
let pendingFrames: FrameRequestCallback[] = []

vi.spyOn(performance, 'now').mockImplementation(() => clockMs)

beforeEach(() => {
  pendingFrames = []
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

/**
 * Advance the clock and run the frames queued for it, as an animation loop would.
 * Wrapped in `act` because a real animation frame is outside React's own event
 * handlers, and an unflushed update would leave the DOM a frame behind.
 */
function pump(advanceMs = 16): void {
  clockMs += advanceMs
  act(() => {
    for (const callback of pendingFrames.splice(0)) callback(clockMs)
  })
}

/** A do-nothing frame: a square-ish body, no face, no decor. */
function frame(over: Partial<BotFrame> = {}): BotFrame {
  return {
    bodyPath: 'M -10 -10 L 10 -10 L 10 10 L -10 10 Z',
    bodyAlpha: 1,
    eyes: [],
    dots: [],
    dotsBehind: true,
    arcs: [],
    notif: null,
    notch: null,
    ...over,
  }
}

/** One orbit ring, with the two-stop gradient the engine always produces. */
function arc(id: string) {
  return {
    id,
    front: 'M 0 0 L 1 1',
    back: 'M 2 2 L 3 3',
    width: 4,
    opacity: 0.5,
    grad: { x1: 1, y1: 2, x2: 3, y2: 4, stops: ['#111111', '#222222'] },
  }
}

describe('companion renderer: the drawing itself', () => {
  it('draws a bare body with the viewBox the engine renders in', () => {
    const { container } = render(<CompanionSvg frame={frame()} size={24} />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('viewBox')).toBe('-158 -158 316 316')
    expect(svg.getAttribute('width')).toBe('24')
    // Decorative by default: a brand mark is named by the control holding it.
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('role')).toBeNull()
  })

  it('names itself when given a label', () => {
    const { container } = render(<CompanionSvg frame={frame()} size={24} label="Agent" state="idle" />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('role')).toBe('img')
    expect(svg.getAttribute('aria-label')).toBe('Agent')
    expect(svg.getAttribute('aria-hidden')).toBeNull()
    expect(svg.getAttribute('data-fcg-state')).toBe('idle')
  })

  it('punches the eyes out of the body and leaves the spare slot empty', () => {
    const one = frame({ eyes: [{ d: 'M 0 0 L 1 1', matrix: 'matrix(1 0 0 1 2 3)', alpha: 0.8 }] })
    const { container } = render(<CompanionSvg frame={one} size={24} />)
    const holes = container.querySelectorAll('mask path')
    // Body plus two eye slots: the missing eye still occupies its slot, empty.
    expect(holes).toHaveLength(3)
    expect(holes[1]!.getAttribute('d')).toBe('M 0 0 L 1 1')
    expect(holes[1]!.getAttribute('transform')).toBe('matrix(1 0 0 1 2 3)')
    expect(holes[1]!.getAttribute('opacity')).toBe('0.8')
    expect(holes[2]!.getAttribute('opacity')).toBe('0')
    expect(holes[2]!.getAttribute('transform')).toBeNull()
  })

  it('cuts a notch out of the mask only when the frame has one', () => {
    const plain = render(<CompanionSvg frame={frame()} size={24} />)
    expect(plain.container.querySelectorAll('mask circle')).toHaveLength(0)
    const notched = render(<CompanionSvg frame={frame({ notch: { x: 1, y: 2, r: 3 } })} size={24} />)
    const notch = notched.container.querySelector('mask circle')!
    expect(notch.getAttribute('cx')).toBe('1')
    expect(notch.getAttribute('r')).toBe('3')
  })

  it('gradients every ring slot, including the ones with no ring in them', () => {
    const { container } = render(<CompanionSvg frame={frame({ arcs: [arc('r1')] })} size={24} />)
    const gradients = container.querySelectorAll('linearGradient')
    expect(gradients).toHaveLength(12)
    expect(gradients[0]!.getAttribute('x1')).toBe('1')
    expect(gradients[0]!.querySelectorAll('stop')).toHaveLength(2)
    // An empty slot still has a definition, at the origin and one stop.
    expect(gradients[1]!.getAttribute('x1')).toBe('0')
    expect(gradients[1]!.querySelectorAll('stop')).toHaveLength(1)
    expect(gradients[1]!.querySelector('stop')!.getAttribute('offset')).toBe('0')
  })

  it('collapses a one-stop gradient onto its single colour', () => {
    const single = { ...arc('r1'), grad: { x1: 0, y1: 0, x2: 0, y2: 0, stops: ['#333333'] } }
    const { container } = render(<CompanionSvg frame={frame({ arcs: [single] })} size={24} />)
    // One stop from the ring, one from each of the eleven empty slots. Queried
    // per element: jsdom lowercases selector names, so the camelCase
    // `linearGradient` never matches in a descendant selector.
    expect(container.querySelectorAll('stop')).toHaveLength(12)
    const gradients = container.querySelectorAll('linearGradient')
    expect(gradients[0]!.querySelectorAll('stop')).toHaveLength(1)
    expect(gradients[0]!.querySelector('stop')!.getAttribute('offset')).toBe('0')
  })

  it('strokes the front and back halves only where a ring exists', () => {
    const { container } = render(<CompanionSvg frame={frame({ arcs: [arc('r1')] })} size={24} />)
    const groups = container.querySelectorAll('g[fill="none"]')
    const back = groups[0]!.querySelectorAll('path')
    const front = groups[1]!.querySelectorAll('path')
    expect(back).toHaveLength(12)
    expect(back[0]!.getAttribute('stroke-width')).toBe('4')
    expect(back[0]!.getAttribute('opacity')).toBe('0.5')
    expect(back[1]!.getAttribute('stroke')).toBe('none')
    expect(back[1]!.getAttribute('d')).toBe('')
    expect(front[0]!.getAttribute('d')).toBe('M 0 0 L 1 1')
  })

  it('keeps back-half decor behind the body by moving it between the two groups', () => {
    const dots = [{ x: 1, y: 2, r: 3, opacity: 1 }]
    const behind = render(<CompanionSvg frame={frame({ dots, dotsBehind: true })} size={24} />)
    const behindGroups = behind.container.querySelectorAll('svg > g')
    expect(behindGroups[1]!.getAttribute('opacity')).toBe('1')
    expect(behindGroups[3]!.getAttribute('opacity')).toBe('0')
    const front = render(<CompanionSvg frame={frame({ dots, dotsBehind: false })} size={24} />)
    const frontGroups = front.container.querySelectorAll('svg > g')
    expect(frontGroups[1]!.getAttribute('opacity')).toBe('0')
    expect(frontGroups[3]!.getAttribute('opacity')).toBe('1')
  })

  it('draws a round particle, a shaped one, and an empty slot three different ways', () => {
    const dots = [
      { x: 1, y: 2, r: 3, opacity: 0.9 },
      { x: 4, y: 5, r: 0, opacity: 1, d: 'M 0 0 L 2 2', rot: 30 },
    ]
    const { container } = render(<CompanionSvg frame={frame({ dots })} size={24} />)
    const front = container.querySelectorAll('svg > g')[3]!.querySelectorAll('circle, path')
    expect(front[0]!.tagName).toBe('circle')
    expect(front[0]!.getAttribute('cy')).toBe('2')
    // A shaped particle is authored in ball-radius units, so the renderer scales
    // it by the resting radius.
    expect(front[1]!.getAttribute('transform')).toBe('translate(4 5) rotate(30) scale(100)')
    expect(front[2]!.getAttribute('r')).toBe('0')
    expect(front[2]!.getAttribute('opacity')).toBe('0')
  })

  it('leaves a shaped particle unrotated when the frame does not rotate it', () => {
    const dots = [{ x: 0, y: 0, r: 0, opacity: 1, d: 'M 0 0 L 1 1' }]
    const { container } = render(<CompanionSvg frame={frame({ dots })} size={24} />)
    const shaped = container.querySelectorAll('svg > g')[3]!.querySelector('path')!
    expect(shaped.getAttribute('transform')).toBe('translate(0 0) rotate(0) scale(100)')
  })

  it('hazes a particle towards the surface colour, or leaves it in ink without one', () => {
    const hazed = [
      { x: 0, y: 0, r: 1, opacity: 1, depth: 0.5 },
      { x: 0, y: 0, r: 1, opacity: 1, depth: 0.5, color: '#abcdef' },
    ]
    const colored = render(<CompanionSvg frame={frame({ dots: hazed })} size={24} ink="#000000" paper="#ffffff" />)
    const coloredDots = colored.container.querySelectorAll('svg > g')[3]!.querySelectorAll('circle')
    // jsdom normalises a colour written into a style declaration.
    expect(coloredDots[0]!.style.fill).toBe('rgb(128, 128, 128)')
    expect(coloredDots[1]!.style.fill).toBe('rgb(171, 205, 239)')
    // A token cannot be mixed in TS, so the haze goes to the stylesheet. Asserted
    // on the token form: jsdom re-serialises a literal colour inside `color-mix`
    // and drops the percentage with it, which is jsdom's parser rather than our
    // string, so the exact-shape cases below use the token path and the literal
    // path is asserted through `dotFill` where no parser is involved.
    const tokenful = render(<CompanionSvg frame={frame({ dots: [hazed[0]!] })} size={24} ink="var(--ink)" paper="var(--paper)" />)
    const tokenDot = tokenful.container.querySelectorAll('svg > g')[3]!.querySelector('circle')!
    expect(tokenDot.style.fill).toBe('color-mix(in srgb, var(--paper) 50.0%, var(--ink))')
    // The default pair — the seat's own tokens, with the renderer's fallbacks —
    // still reaches the DOM as a mix rather than a flat fill.
    const symbolic = render(<CompanionSvg frame={frame({ dots: [hazed[0]!] })} size={24} />)
    const symbolicDot = symbolic.container.querySelectorAll('svg > g')[3]!.querySelector('circle')!
    expect(symbolicDot.style.fill.toLowerCase()).toContain('color-mix(in srgb,')
  })

  it('hazes exactly between the surface and the ink, in both colour kinds', () => {
    // Literal colours mix in TS, in parity with the reference renderer.
    expect(dotFill(undefined, 0.5, '#000000', '#ffffff')).toBe('#808080')
    expect(dotFill(undefined, 0, '#000000', '#ffffff')).toBe('#ffffff')
    expect(dotFill(undefined, 1, '#000000', '#ffffff')).toBe('#000000')
    // A token goes to the stylesheet, which resolves it at paint time. The
    // percentage is the surface's share, so depth 0 is all surface.
    expect(dotFill(undefined, 0.25, 'var(--ink)', 'var(--paper)'))
      .toBe('color-mix(in srgb, var(--paper) 75.0%, var(--ink))')
    expect(dotFill(undefined, 0, 'var(--ink)', 'var(--paper)'))
      .toBe('color-mix(in srgb, var(--paper) 100.0%, var(--ink))')
    // A half-symbolic pair takes the same path: one token is enough to lose the mix.
    expect(dotFill(undefined, 0.5, 'currentColor', '#ffffff'))
      .toBe('color-mix(in srgb, #ffffff 50.0%, currentColor)')
    // The particle's own colour and the absence of a depth both bypass the haze.
    expect(dotFill('#abcdef', 0.5, '#000000', '#ffffff')).toBe('#abcdef')
    expect(dotFill(undefined, undefined, '#000000', '#ffffff')).toBe('#000000')
  })

  it('paints the notification pill only when the frame carries one', () => {
    const plain = render(<CompanionSvg frame={frame()} size={24} />)
    expect(plain.container.querySelectorAll('circle[fill="#2496e8"]')).toHaveLength(0)
    const notified = render(<CompanionSvg frame={frame({ notif: { x: 7, y: 8, r: 9 } })} size={24} />)
    expect(notified.container.querySelectorAll('circle[fill="#2496e8"]')).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ the wiring */

interface SessionRow {
  /** The session identity; the seat names the open session by it. */
  id: string
  running: boolean
  completed?: boolean
  blank: boolean
  /** Local ownership counts; the row the main view retains is the visible one. */
  retainedBy: Readonly<Partial<Record<string, number>>>
}

interface JobsRow {
  /** Required, like the host's own `SessionJob`: the seat identifies a failure by
   *  this id, so a fixture without one could not catch that dependency. */
  id: string
  status: string
}

/**
 * A case's input shape for the Session list a seat reads.
 *
 * `state` below derives the two fields the seat actually reads — each row's
 * identity and its ownership counts — from the `byId` key and the `current`
 * shorthand, so a case states which session is open exactly once instead of
 * restating `retainedBy` at every call site.
 */
interface SessionsStateInput {
  current?: string | undefined
  byId?: Record<string, Omit<SessionRow, 'id' | 'retainedBy'>>
  jobsBySession?: Record<string, readonly JobsRow[]>
}

interface SessionsState {
  byId: Record<string, SessionRow>
  jobsBySession: Record<string, readonly JobsRow[]>
}

/** The component's own props type, so the stubs cannot drift from the seat. */
type CompanionProps = Parameters<typeof FreeCodeGoCompanion>[0]

/**
 * The status snapshot the host exposes, built from the ids whose ask is pending.
 *
 * The interaction itself is folded into `SessionStatus` upstream, and only its
 * *presence* is what a seat reads — so the request payload is stood in for rather
 * than hand-built: its real shape is a declaration-merged union the assembled
 * Client decides, which a fixture could only guess at.
 */
function pendingStatuses(pending: ReadonlySet<string>): ReadonlyMap<string, SessionStatus> {
  const byId = new Map<string, SessionStatus>()
  for (const id of pending) {
    byId.set(id, {
      running: undefined,
      pendingInteraction: {} as NonNullable<SessionStatus['pendingInteraction']>,
      completionUnread: false,
    })
  }
  return byId
}

/** Render the seat against stub standard-prop hooks. */
function setup(sessions: SessionsState, pending: ReadonlySet<string> = new Set(), activity = activityFixture()) {
  const props = {
    size: 24,
    useSessions: (selector: (state: SessionsState) => unknown) => selector(sessions),
    useSessionStatus: (selector: (map: ReadonlyMap<string, SessionStatus>) => unknown) => selector(pendingStatuses(pending)),
    // The live feed is injected rather than read from a store, by design: the rail
    // mark is outside any session scope and still shows the phases inside a turn.
    activity,
  }
  return render(<FreeCodeGoCompanion {...props as CompanionProps} />)
}

/**
 * The Session list state a seat reads, with `current` naming the open session.
 *
 * alpha.2 removed `SessionListState.current`: which session is on screen is
 * expressed as ownership now, and the row the main view retains is the visible
 * one — the same derivation the seat itself makes. Translating the shorthand here
 * keeps every case below reading as the fact it is about instead of restating
 * ownership at each call site.
 */
function state(over: SessionsStateInput = {}): SessionsState {
  const { current, byId = {}, jobsBySession = {} } = over
  return {
    byId: Object.fromEntries(Object.entries(byId).map(([id, row]) => [id, {
      ...row,
      id,
      retainedBy: id === current ? { mainView: 1 } : {},
    }])),
    jobsBySession,
  }
}

/** @returns the pose the seat is currently showing. */
function pose(container: HTMLElement): string | null {
  return container.querySelector('svg')!.getAttribute('data-fcg-state')
}

describe('companion seat: session activity drives the pose', () => {
  it('rests at the brand mark size when nothing is happening', () => {
    const { container } = setup(state())
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('24')
    expect(svg.getAttribute('class')).toBe('fcg-companion')
    expect(pose(container)).toBe('idle')
  })

  it('thinks while the selected session is producing a turn', () => {
    const sessions = state({ current: 's1', byId: { s1: { running: true, blank: false } } })
    const { container } = setup(sessions)
    pump()
    expect(pose(container)).toBe('thinking')
  })

  it('works while a background job is live and asks when one fails', () => {
    const busy = state({ current: 's1', byId: { s1: { running: false, blank: false } }, jobsBySession: { s1: [{ id: 'job-live', status: 'running' }] } })
    const first = setup(busy)
    pump()
    expect(pose(first.container)).toBe('orbit')

    const broken = state({ current: 's1', byId: { s1: { running: false, blank: false } }, jobsBySession: { s1: [{ id: 'job-failed', status: 'failed' }] } })
    const second = setup(broken)
    pump()
    expect(pose(second.container)).toBe('exclaim')
  })

  it('stops for a stalled job as well as a running one', () => {
    const sessions = state({ current: 's1', byId: { s1: { running: false, blank: false } }, jobsBySession: { s1: [{ id: 'job-stopping', status: 'stopping' }] } })
    const { container } = setup(sessions)
    pump()
    expect(pose(container)).toBe('orbit')
  })

  it('ignores jobs of sessions that are not selected', () => {
    const sessions = state({ current: 's1', byId: { s1: { running: false, blank: false } }, jobsBySession: { s2: [{ id: 'job-other', status: 'running' }] } })
    const { container } = setup(sessions)
    pump()
    expect(pose(container)).toBe('idle')
  })

  it('waits for the user when an interaction is pending', () => {
    const sessions = state({ current: 's1', byId: { s1: { running: true, blank: false } } })
    const { container } = setup(sessions, new Set(['s1']))
    pump()
    expect(pose(container)).toBe('alert')
  })

  it('does not wait on an interaction addressed to another session', () => {
    const sessions = state({ current: 's1', byId: { s1: { running: false, blank: false } } })
    const { container } = setup(sessions, new Set(['s2']))
    pump()
    expect(pose(container)).toBe('idle')
  })

  it('celebrates a turn ending once the running pose has served its floor', () => {
    const sessions = state({ current: 's1', byId: { s1: { running: true, blank: false } } })
    // The same feed across the rerender, so the seat keeps one source: a fresh one
    // would be a different feed object for the same character.
    const activity = activityFixture()
    const view = setup(sessions, new Set(), activity)
    pump()
    expect(pose(view.container)).toBe('thinking')

    sessions.byId.s1 = { id: 's1', running: false, blank: false, retainedBy: { mainView: 1 } }
    view.rerender(<FreeCodeGoCompanion {...({
      size: 24,
      useSessions: (selector: (value: SessionsState) => unknown) => selector(sessions),
      useSessionStatus: (selector: (map: ReadonlyMap<string, SessionStatus>) => unknown) => selector(new Map()),
      activity,
    }) as CompanionProps} />)
    // The completion outranks the resting pose but not an in-flight one, so the
    // turn's own floor passes first — this is the dwell doing its job...
    pump(100)
    expect(pose(view.container)).toBe('thinking')
    // ...and the completion is still on offer when it expires.
    pump(700)
    expect(pose(view.container)).toBe('burst')
  })

  it('opens a fresh seat at rest, not asleep, on a clock that has been running', () => {
    // The rail mark mounts at app start and the strip mounts when a session
    // opens, so a later seat starts on a clock that already reads minutes. A
    // quiet timer seeded from zero would read that as a long silence and open
    // the new seat on the powered-down pose instead of rest.
    const first = setup(state())
    pump(IDLE_AFTER_MS * 2)
    expect(pose(first.container)).toBe('sleep')

    const second = setup(state())
    pump()
    expect(pose(second.container)).toBe('idle')
  })
})

describe('companion: taking its seats', () => {
  it('waits for each declaration, shadows the rail mark, and docks the strip', () => {
    const injected: string[] = []
    const registered: Record<string, unknown>[] = []
    const dictionaries: { ns: string; values: unknown }[] = []
    const disposers: (() => void)[] = []
    const ctx = {
      // The real context registers the namespace inside an effect; the stub runs
      // the callback so the registration is observable here, and keeps the
      // disposer so a seat that watches the document has to hand one back.
      effect: (callback: () => unknown) => {
        const result = callback()
        if (typeof result === 'function') disposers.push(result as () => void)
      },
      // The transcript seat reads the same two stores the slot Hooks are built
      // over; both are empty here, since this case is about the seating itself.
      sessions: {
        list: {
          getSnapshot: () => ({ ids: [], byId: {}, jobsBySession: {} }),
          subscribe: () => () => {},
        },
      },
      uiSession: { sessionStatus: { getSnapshot: () => new Map(), subscribe: () => () => {} } },
      locale: {
        register: (ns: string, values: unknown) => {
          dictionaries.push({ ns, values })
          return () => {}
        },
      },
      slots: {
        inject: (name: string, callback: () => void) => { injected.push(name); callback() },
        register: (options: Record<string, unknown>, _component: unknown) => {
          registered.push(options)
          return () => {}
        },
      },
    }
    installCompanion(ctx as never)
    // Declaration order is not assumed: each seat waits for its own slot.
    expect(injected).toEqual(['sidebar.brand.mark', 'conversation.input.dock'])
    expect(registered).toEqual([
      // The rank is the whole mechanism for the single slot: the fallback mark
      // sits at the default 0, and the lowest live entry is the one drawn.
      { name: 'sidebar.brand.mark', priority: -1, registrant: 'freecodego-companion' },
      // The strip is a fourth list entry at a new id, ordered after upstream's
      // todo (0), goal (10), and queue (20), so it sits closest to the input.
      {
        name: 'conversation.input.dock',
        id: 'freecodego-companion',
        order: 30,
        locale: 'freecodego.companion',
        registrant: 'freecodego-companion',
      },
    ].map(entry => ({ ...entry, inject: expect.any(Function) })))
    // One namespace carrying both languages: the strip's label resolves through it.
    expect(dictionaries).toEqual([{ ns: 'freecodego.companion', values: { zh, en } }])
    // The transcript's three seats are injections rather than registrations, so the
    // evidence that they were taken is their stylesheets — and that each handed
    // back the disposer the effect above is the only thing that can ever call.
    const sheets = [
      '[data-fcg-running-row-style]',
      '[data-fcg-step-row-style]',
      '[data-fcg-dot-row-style]',
    ]
    for (const selector of sheets) expect(document.head.querySelector(selector)).not.toBeNull()
    // The three injections and the live feed; the feed is the one every seat reads,
    // so it has to be disposed with the fiber that created it.
    expect(disposers).toHaveLength(5)
    for (const dispose of disposers) dispose()
    for (const selector of sheets) document.head.querySelector(selector)?.remove()
  })
})

describe('companion seat: reduced motion', () => {
  it('freezes the pose instead of advancing it', () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    const sessions = state({ current: 's1', byId: { s1: { running: true, blank: false } } })
    const { container } = setup(sessions)
    pump()
    expect(pose(container)).toBe('thinking')
    const frozen = container.querySelector('path')!.getAttribute('d')
    // Further frames of the same state must not move the drawing.
    pump(500)
    pump(500)
    expect(container.querySelector('path')!.getAttribute('d')).toBe(frozen)
  })

  it('freezes a state that declares how long it must be held', () => {
    // Rest and thinking have no declared floor, so they freeze at the midpoint of
    // their cycle. A state that declares one — orbit asks for 2.5s — freezes
    // there instead, because that is the frame the state is *about*.
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    const sessions = state({ current: 's1', byId: { s1: { running: false, blank: false } }, jobsBySession: { s1: [{ id: 'job-orbit', status: 'running' }] } })
    const { container } = setup(sessions)
    pump()
    expect(pose(container)).toBe('orbit')
    const frozen = container.querySelector('path')!.getAttribute('d')
    pump(500)
    expect(container.querySelector('path')!.getAttribute('d')).toBe(frozen)
  })

  it('rests on the engine\u2019s own circle rather than a shape it chose', () => {
    // The seat passes no shape override, which the engine reads as "its own
    // resting profile". That is only identical to the table's `cercle` while that
    // stays a uniform radius, so the equality is what this locks: if the vendored
    // profile table ever stops making `cercle` the unit circle, the companion is
    // drawn as a different character and this fails rather than the change sliding
    // into a sync.
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    const { container } = setup(state())
    pump()
    expect(pose(container)).toBe('idle')
    const idle = STATE_BY_ID.get('idle')!
    // The same freeze rule the component uses, so no magic instant is written down.
    const frozenAt = idle.minDuration ?? idle.duration / 2
    const circle = SHAPES.find(shape => shape.id === 'cercle')!.radii
    const named = new BotEngine(RAYON, 'idle', circle, null).sample(frozenAt)
    const unnamed = new BotEngine(RAYON, 'idle').sample(frozenAt)
    expect(unnamed.bodyPath).toBe(named.bodyPath)
    expect(container.querySelector('path')!.getAttribute('d')).toBe(unnamed.bodyPath)
  })
})

describe('companion seat: environment edges', () => {
  it('renders without a reduced-motion preference to consult', () => {
    vi.stubGlobal('matchMedia', undefined)
    const { container } = setup(state())
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('follows the preference changing under it', () => {
    const listeners = new Set<() => void>()
    const query = {
      matches: false,
      addEventListener: (_type: string, listener: () => void) => { listeners.add(listener) },
      removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener) },
    }
    vi.stubGlobal('matchMedia', () => query)
    const sessions = state({ current: 's1', byId: { s1: { running: true, blank: false } } })
    const { container } = setup(sessions)
    pump()
    const moving = container.querySelector('path')!.getAttribute('d')
    pump(300)
    expect(container.querySelector('path')!.getAttribute('d')).not.toBe(moving)
    // Switching motion off freezes the pose where it stands.
    query.matches = true
    for (const notify of listeners) notify()
    pump()
    const frozen = container.querySelector('path')!.getAttribute('d')
    pump(300)
    expect(container.querySelector('path')!.getAttribute('d')).toBe(frozen)
  })
})
