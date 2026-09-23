// @vitest-environment jsdom
/**
 * The companion's transcript seat: the shell's running rows.
 *
 * Upstream sweeps every row that is still working — a translucent band gliding
 * across it — and spells that one idiom five times, on the row's *box* in one case
 * and on a row element inside a running wrapper in the other four. The seat finds
 * the band instead of enumerating the spellings (`findBandHost`), so what belongs
 * to this seat is asserted here:
 *
 * - the band is found in all three measured shapes — a declared row header, a
 *   hand-rolled row that paints its own sweep, and a running element whose own box
 *   paints it — with the face mounted into the element that painted it;
 * - a running element with neither is left alone *and* unmarked, so a later pass can
 *   still take it;
 * - a settled row is never looked at;
 * - the row whose own in-flight mark is the shell's ongoing dot is left to
 *   `./dot-row.tsx`, and with both seats installed such a row draws exactly one
 *   character — the interaction the two seats exist to get right;
 * - the injection's lifetime is the element's: the band host leaving the document
 *   takes the face and the marker with it.
 *
 * The last block pins the *premise* against the synced upstream source: the band is a
 * pseudo-element with a box and an animation (what the probe reads), it is still
 * scoped to `data-state='running'`, the declared row header is still a descendant of
 * the running element, and the bash row's band is still painted on its own box. A
 * rename or a move that would leave the official sweep running fails there rather
 * than shipping.
 *
 * Frames are pumped by hand and the mocked clock only ever moves forward, for the
 * reason the sibling seat specs give: the clock is a process singleton, so a counter
 * that restarted per test would read as time running backwards.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
// Imported rather than read off the global: the client ambient `process` is the
// build-time subset (`env` only), so `process.cwd()` is not part of this shape.
import nodeProcess from 'node:process'
import { act, cleanup } from '@testing-library/react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STEP_ROW_ATTR,
  STEP_ROW_FACE_ATTR,
  STEP_ROW_FACE_PX,
  STEP_ROW_SELECTOR,
  findBandHost,
  installStepRows,
  paintsBand,
} from '../src/client/companion/step-row.tsx'
import type { CompanionActivitySource } from '../src/client/companion/activity.ts'
import { DOT_FACE_ATTR, installDotFaces } from '../src/client/companion/dot-row.tsx'
import { activityFixture } from './companion-activity.fixture.ts'

/** Monotonic for the whole file, for the reason in the header. */
let clockMs = 0
/** Frames queued by the stub `requestAnimationFrame`, drained by {@link pump}. */
let pendingFrames: FrameRequestCallback[] = []
/** Every injection a case installed, disposed after it. */
let installed: (() => void)[] = []

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
  for (const tag of document.head.querySelectorAll('[data-fcg-step-row-style],[data-fcg-dot-row-style]')) {
    tag.remove()
  }
})

/**
 * Advance the clock and run the frames queued for it.
 *
 * The seat's own scan is scheduled on a frame; the React root it mounts is not — a
 * root rendered outside a React tree commits on the scheduler's own turn — so a pass
 * also has to let that commit land before anything is asserted.
 */
async function pump(advanceMs = 16): Promise<void> {
  clockMs += advanceMs
  await act(async () => {
    for (const callback of pendingFrames.splice(0)) callback(clockMs)
  })
}

/** The Session list snapshot the readers consume. */
interface SessionsState {
  ids: string[]
  byId: Record<string, { id: string; running: boolean; retainedBy: { mainView?: number } }>
  phase: 'ready'
  projectionsBySession: Record<string, never>
}

/** A snapshot source the test pushes into, shaped like `ObservableSnapshot`. */
function source<T>(initial: T): { getSnapshot: () => T; subscribe: (listener: () => void) => () => void } {
  const value = initial
  return {
    getSnapshot: () => value,
    subscribe: () => () => {},
  }
}

/** The fake context the seats are installed into: one running session, no jobs. */
function context(): ClientContext {
  const sessions: SessionsState = {
    ids: ['s1'],
    byId: { s1: { id: 's1', running: true, retainedBy: { mainView: 1 } } },
    phase: 'ready',
    projectionsBySession: {},
  }
  return {
    sessions: { list: source(sessions) },
    // No job here, but the source still has to exist: the seat reads
    // `ctx.jobs.state` while it installs.
    jobs: { state: source({ rows: {}, observed: {} }) },
    uiSession: { sessionStatus: source(new Map()) },
  } as unknown as ClientContext
}

/** A probe that answers for the fixture's own marker — there is no style engine here. */
const byMarker = (element: HTMLElement): boolean => element.hasAttribute('data-test-band')

/** Install the step-row seat over the fixture, with the marker probe. */
function install(
  extra: (ctx: ClientContext, activity: CompanionActivitySource) => () => void = () => () => {},
): (() => void)[] {
  const ctx = context()
  // One feed for both seats in the case, as the plugin installs them: a case that
  // takes the row over and asks the dot seat beside it must be answering about the
  // same activity, or it is testing two different plugins.
  const activity = activityFixture()
  const disposers = [
    installStepRows(ctx, activity, { bandProbe: byMarker }),
    extra(ctx, activity),
  ]
  installed.push(...disposers)
  return disposers
}

/** @returns the marker probe's answer for a fixture node. */
function marked(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[${STEP_ROW_ATTR}]`)]
}

/** @returns the injected containers, in document order. */
function faces(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[${STEP_ROW_FACE_ATTR}]`)]
}

/** The three measured band shapes, each with its row's own leading content. */
const SHAPES = {
  /** Declared row header: what `ui-chat`'s command and reasoning rows render. */
  declared: '<div data-state="running"><div data-disclosure-row><span class="leading"></span><span class="title">bash</span></div></div>',
  /** Hand-rolled row: `ui-skill` paints its own sweep inside a running card. */
  handRolled: '<div data-state="running" data-tool="skill"><div class="row" data-test-band><span class="leading"></span><span class="title">skill</span></div></div>',
  /** Own box: the bash row paints the band on the element that reports the state. */
  ownBox: '<div data-state="running" data-sample="bash" data-test-band><span class="leading"></span><span class="title">运行命令</span></div>',
} as const

describe('companion step rows: finding the sweep, whatever shape it is drawn in', () => {
  for (const [name, html] of Object.entries(SHAPES)) {
    it(`takes the band over and mounts the face into it: ${name}`, async () => {
      document.body.innerHTML = html
      install()
      await pump()
      const [host] = marked() as [HTMLElement]
      const [face] = faces() as [HTMLElement]
      // The element that painted the band is the element the face went into, and it
      // is already in the row: nothing was moved, and the row's own content is intact.
      expect(host.contains(face)).toBe(true)
      expect(face.querySelector('svg')?.getAttribute('width')).toBe(String(STEP_ROW_FACE_PX))
      expect(host.textContent).toContain(name === 'ownBox' ? '运行命令' : name === 'declared' ? 'bash' : 'skill')
    })
  }

  it('picks the declared header without measuring, and the band by measuring otherwise', () => {
    // The fast path is a decision, not an optimisation detail: `findBandHost` answers
    // from the DOM when upstream declares the row, and only falls back to the style
    // engine for the hand-rolled shapes.
    const build = (html: string): HTMLElement => {
      const wrapper = document.createElement('div')
      wrapper.innerHTML = html
      const host = wrapper.firstElementChild as HTMLElement
      document.body.append(host)
      return host
    }
    const declared = build(SHAPES.declared)
    const handRolled = build(SHAPES.handRolled)
    const ownBox = build(SHAPES.ownBox)
    const answered: string[] = []
    const probe = (element: HTMLElement): boolean => {
      answered.push(element.className)
      return byMarker(element)
    }
    // Declared: the answer comes from the attribute, with the style engine untouched.
    expect(findBandHost(declared, probe)?.hasAttribute('data-disclosure-row')).toBe(true)
    expect(answered).toHaveLength(0)
    // Hand-rolled: measured, and the band is the row inside the running card.
    expect(findBandHost(handRolled, probe)?.className).toBe('row')
    expect(answered.length).toBeGreaterThan(0)
    // Own box: the running element itself answers, and is the band's host.
    answered.length = 0
    expect(findBandHost(ownBox, probe)).toBe(ownBox)
    expect(answered).toEqual([''])
  })

  it('leaves a running element that paints no band unmarked, so a later pass can take it', async () => {
    document.body.innerHTML = '<div data-state="running"><span class="title">会话</span></div>'
    install()
    await pump()
    expect(marked()).toHaveLength(0)
    expect(faces()).toHaveLength(0)
  })

  it('never looks at a settled row', async () => {
    document.body.innerHTML = '<div data-state="ok" data-test-band><span class="title">bash</span></div>'
    install()
    await pump()
    expect(document.querySelectorAll(STEP_ROW_SELECTOR)).toHaveLength(0)
    expect(marked()).toHaveLength(0)
    expect(faces()).toHaveLength(0)
  })

  it('mounts one face per band host however many scans run', async () => {
    document.body.innerHTML = SHAPES.handRolled
    install()
    await pump()
    await pump()
    await pump()
    expect(marked()).toHaveLength(1)
    expect(faces()).toHaveLength(1)
  })

  it('switches the band off on the element it marked', async () => {
    document.body.innerHTML = SHAPES.declared
    install()
    await pump()
    const sheet = document.head.querySelector<HTMLStyleElement>('[data-fcg-step-row-style]')
    expect(sheet).not.toBeNull()
    const css = sheet!.textContent ?? ''
    // `content: none` removes the band and the animation is disabled beside it, so
    // nothing is left running with no paint.
    expect(css).toContain(`[${STEP_ROW_ATTR}]::after`)
    expect(css).toContain('content: none !important')
    expect(css).toContain('animation: none !important')
  })

  it('releases the face and the marker with the band host', async () => {
    document.body.innerHTML = SHAPES.handRolled
    install()
    await pump()
    const host = marked()[0]!
    act(() => { host.parentElement!.remove() })
    await pump()
    expect(faces()).toHaveLength(0)
    expect(marked()).toHaveLength(0)
  })
})

describe('companion step rows: the row whose own mark is the ongoing dot', () => {
  /** A running row that paints a band *and* shows the shell's in-flight dot. */
  const ROW = `
    <div data-state="running" data-tool="present" data-test-band>
      <div data-disclosure-row>
        <span class="leading"><svg data-state="ongoing" width="10" height="10"></svg></span>
        <span class="title">已呈现</span>
      </div>
    </div>
  `

  /** The same row where it is shipped: inside the conversation's chat column. */
  const BOTH = `<div data-chat-flow="">${ROW}</div>`

  it('leaves that row to the dot seat rather than drawing a second character', async () => {
    document.body.innerHTML = BOTH
    install()
    await pump()
    // Not this seat's row: the character's place is the mark's slot, which is the
    // dot seat's business.
    expect(marked()).toHaveLength(0)
    expect(faces()).toHaveLength(0)
  })

  it('takes the band of a row whose dot the dot seat will not claim', async () => {
    // The hand-off is asked through the dot seat's own predicate, so a dot *outside*
    // the conversation is not a mark being handed over: nothing else would draw there
    // and the row would lose its indicator altogether. No measured row has both a band
    // and a dot, so this is the pairing of the two rules, not a shape upstream ships.
    document.body.innerHTML = `<div class="page">${ROW}</div>`
    install(installDotFaces)
    await pump()
    expect(marked()).toHaveLength(1)
    expect(faces()).toHaveLength(1)
    expect(document.querySelectorAll(`[${DOT_FACE_ATTR}]`)).toHaveLength(0)
  })

  it('draws exactly one character in it when both seats are installed', async () => {
    document.body.innerHTML = BOTH
    install(installDotFaces)
    await pump()
    expect(faces()).toHaveLength(0)
    const dots = [...document.querySelectorAll<HTMLElement>(`[${DOT_FACE_ATTR}]`)]
    expect(dots).toHaveLength(1)
    // In the dot's own slot, inside the row's leading box — where the shell was
    // animating, and no second face anywhere in the row.
    expect(dots[0]!.parentElement?.className).toBe('leading')
    expect(dots[0]!.closest('[data-disclosure-row]')).not.toBeNull()
    expect(document.querySelectorAll('svg[data-fcg-state]')).toHaveLength(1)
  })
})

describe('companion step rows: the probe the browser answers', () => {
  /**
   * Stand in for the style engine, which jsdom does not have for pseudo-elements.
   *
   * The fixture says what the pseudo-element computes to, and the probe's own
   * questions are then asserted rather than assumed: a real engine answers exactly
   * this way for the sweep, and this is the only place the reading is testable
   * without a browser.
   */
  function styleEngine(answers: (element: HTMLElement) => { content: string; animationName: string }): void {
    vi.stubGlobal('getComputedStyle', (element: HTMLElement) => answers(element))
  }

  it('reads a band out of an ::after that has both a box and an animation', () => {
    const band = document.createElement('div')
    const decorative = document.createElement('div')
    const empty = document.createElement('div')
    const silent = document.createElement('div')
    styleEngine((element) => {
      if (element === band) return { content: '""', animationName: 'dsh-tool-row-sweep' }
      if (element === decorative) return { content: '""', animationName: 'none' }
      if (element === empty) return { content: 'none', animationName: 'dsh-tool-row-sweep' }
      return { content: 'normal', animationName: 'none' }
    })
    expect(paintsBand(band)).toBe(true)
    // A box with no animation is a decoration; an animation with no box paints
    // nothing. Either alone would take over something that is not the sweep.
    expect(paintsBand(decorative)).toBe(false)
    expect(paintsBand(empty)).toBe(false)
    expect(paintsBand(silent)).toBe(false)
  })

  it('answers \u201Cno band\u201D when there is no engine to ask', () => {
    vi.stubGlobal('getComputedStyle', () => { throw new Error('not implemented') })
    expect(paintsBand(document.createElement('div'))).toBe(false)
  })

  it('is the probe the seat actually uses', async () => {
    // The injected probe above is a seam for the fixtures; this is the same seat
    // installed the way production installs it, with a stand-in engine answering for
    // one hand-rolled row.
    document.body.innerHTML = SHAPES.handRolled
    styleEngine((element) => element.hasAttribute('data-test-band')
      ? { content: '""', animationName: 'dsh-skill-row-sweep' }
      : { content: 'none', animationName: 'none' })
    installed.push(installStepRows(context(), activityFixture()))
    await pump()
    expect(marked()).toHaveLength(1)
    expect(faces()).toHaveLength(1)
  })
})

describe('companion step rows: the upstream shapes this was measured from', () => {
  /**
   * The sheets that still carry the sweep, as spellings inside the client.
   *
   * Re-measured: five of them did when this seat was written, and the revision that
   * introduced the turn-process row dropped three — `GenericCommandCard`, `ui-tool`'s
   * `ToolRow`, and the bash sample. Those rows now keep the shell's own look, which is
   * the right outcome: there is no band left for the seat to replace. Only the two
   * spellings that stayed are listed, so the gate fails on a sheet that has lost its
   * sweep rather than on one that legitimately never had it.
   */
  const SWEEP_SHEETS = [
    'ui-chat/src/client/chat/ReasoningRow.module.css',
    'ui-skill/src/client/SkillRow.module.css',
  ]

  /** Read a file out of the synced upstream client. */
  function upstream(relative: string): string {
    return readFileSync(resolve(nodeProcess.cwd(), 'packages/client', relative), 'utf8')
  }

  it('paints every sweep on an animated ::after of a running element', () => {
    // The probe reads exactly this: a pseudo-element that has both a box and an
    // animation. A band that moved to a real element, or lost its animation, would
    // stop being found — and this is what says so first.
    for (const sheet of SWEEP_SHEETS) {
      const css = upstream(sheet)
      const sweep = /[^}]*::after\s*\{[^}]*animation:\s*dsh-\S*-row-sweep[^}]*\}/.exec(css)
      expect(sweep, sheet).not.toBeNull()
      expect(sweep![0], sheet).toContain("content: ''")
      expect(sweep![0], sheet).toContain("[data-state='running']")
    }
  })

  it('still declares its row header on a descendant, but not in the hand-rolled shapes', () => {
    // The fast path is upstream's own marker; it exists in `DisclosureRow` and
    // nowhere else, so the three rows that render one are answered without a probe.
    expect(upstream('ui-primitives/src/DisclosureRow.tsx')).toContain('data-disclosure-row')
    // The two shapes the probe exists for: the skill card hand-rolls its row, and the
    // reasoning row reports the state on the box around the row it paints the band on.
    expect(upstream('ui-skill/src/client/SkillRow.tsx')).not.toContain('DisclosureRow')
    expect(upstream('ui-skill/src/client/SkillRow.tsx')).toContain('data-state={model.state}')
    // Re-measured: both surviving spellings paint the band one level in — on the row
    // *inside* the running element, not on that element itself. The probe asks which
    // element paints the band either way, so the character follows it in.
    expect(upstream('ui-chat/src/client/chat/ReasoningRow.module.css'))
      .toContain(".root[data-state='running'] .row::after")
    expect(upstream('ui-skill/src/client/SkillRow.module.css'))
      .toContain(".card[data-state='running'] .row::after")
  })
})
