// @vitest-environment jsdom
/**
 * The companion's seat at the shell's in-flight dot.
 *
 * `StateDot` draws the ongoing state as an eight-cell pixel chase — a real element
 * with cells inside it, and the shell's loading animation away from the row sweeps.
 * What belongs to this seat is asserted here:
 *
 * - the character stands where the dot was: in the dot's own slot, inside the
 *   element that held it, with the dot's own classes carried over so the callsite's
 *   layout is unchanged;
 * - the dot itself is switched off rather than removed, which is what keeps React
 *   the owner of the node it rendered — and is what makes the mark going away the
 *   event that releases the character (the case below removes it as React would);
 * - the size rule: the marks upstream draws are 8px and 10px, and the character is
 *   drawn at 14px in their slot, never larger than 20;
 * - a settled dot is not an animation and is left alone;
 * - the mark is only the *conversation's*: the transcript, the composer area, and the
 *   session header's action row are taken over, and a settings page's own loading dot
 *   (a package installing) keeps the dot upstream drew, because the character speaks
 *   for the agent and not for a fiber.
 *
 * The last block pins the premise against the synced upstream source: the ongoing
 * state is the only `svg[data-state]` `StateDot` emits, its animation is on the
 * cells, and a running present row is exactly the case the two seats split between
 * them (the row seat's own half is `./companion-step-row.client.spec.tsx`).
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
  CONVERSATION_SURFACE,
  DOT_ATTR,
  DOT_FACE_ATTR,
  DOT_FACE_MAX_PX,
  DOT_FACE_MIN_PX,
  ONGOING_DOT_SELECTOR,
  faceEdgeFor,
  inConversationSurface,
  installDotFaces,
} from '../src/client/companion/dot-row.tsx'
import { activityFixture } from './companion-activity.fixture.ts'

/** Monotonic for the whole file, for the reason the sibling seat specs give. */
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
  document.head.querySelector('[data-fcg-dot-row-style]')?.remove()
})

/** Advance the clock and run the frames queued for it, as the seat's scan needs. */
async function pump(advanceMs = 16): Promise<void> {
  clockMs += advanceMs
  await act(async () => {
    for (const callback of pendingFrames.splice(0)) callback(clockMs)
  })
}

/** A snapshot source shaped like the host's `ObservableSnapshot`. */
function source<T>(initial: T): { getSnapshot: () => T; subscribe: (listener: () => void) => () => void } {
  const value = initial
  return { getSnapshot: () => value, subscribe: () => () => {} }
}

/** The fake context: one running session, nothing else true about it. */
function context(): ClientContext {
  return {
    sessions: {
      list: source({
        ids: ['s1'],
        byId: { s1: { id: 's1', running: true, retainedBy: { mainView: 1 } } },
        jobsBySession: { s1: [] },
      }),
    },
    uiSession: { sessionStatus: source(new Map()) },
  } as unknown as ClientContext
}

/** @returns the ongoing dot the fixture holds. */
function dot(): HTMLElement {
  return document.querySelector<HTMLElement>(ONGOING_DOT_SELECTOR)!
}

/** @returns the container the character was mounted into. */
function face(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${DOT_FACE_ATTR}]`)
}

/** The jobs trigger's mark, as `JobListAction` renders it. */
const TRIGGER = '<button class="trigger"><svg data-state="ongoing" class="matrix triggerDot" width="10" height="10" viewBox="0 0 10 10"></svg><span class="count">2</span></button>'

/** The session header, whose `actions` seat is where the jobs trigger lives. */
const HEADER = `
  <header>
    <div data-conversation-header-leading=""></div>
    <div class="actions">${TRIGGER}</div>
    <div data-conversation-header-corner=""></div>
  </header>
`

/**
 * A settings page's own header and body, as the plugin manager draws them.
 *
 * Both a dot *inside* that page's `<header>` and one in its body: the session header
 * is recognised by the slots it holds, and a page header holds none of them — so
 * neither of these is the conversation's chrome.
 */
const SETTINGS_PAGE = `
  <div class="page">
    <header><div class="pageTitle">插件</div><svg data-state="ongoing" class="matrix headDot" width="10" height="10"></svg></header>
    <section><button class="row"><svg data-state="ongoing" class="matrix rowDot" width="8" height="8"></svg><span>正在加载</span></button></section>
  </div>
`

/** Install the seat over a fixture inside the conversation's chat column. */
async function setup(html: string): Promise<void> {
  await install(`<div data-chat-flow="">${html}</div>`)
}

/** Install the seat over a fixture that is not the conversation at all. */
async function setupOutside(html: string): Promise<void> {
  await install(html)
}

/** Install the seat over the given markup, verbatim. */
async function install(html: string): Promise<void> {
  document.body.innerHTML = html
  installed.push(installDotFaces(context(), activityFixture()))
  await pump()
}

describe('companion dot: standing in the shell\u2019s in-flight mark', () => {
  it('takes the dot\u2019s slot, its classes, and leaves the dot itself to React', async () => {
    await setup(TRIGGER)
    const mark = dot()
    const container = face()
    expect(container).not.toBeNull()
    // Switched off, not removed: React still owns this node, and its removal is the
    // event that gives the character back (see the lifetime case below).
    expect(mark.getAttribute(DOT_ATTR)).toBe('true')
    expect(mark.isConnected).toBe(true)
    const css = document.head.querySelector<HTMLStyleElement>('[data-fcg-dot-row-style]')!.textContent ?? ''
    expect(css).toContain(`[${DOT_ATTR}]`)
    expect(css).toContain('display: none !important')
    // In the dot's slot, with the dot's own class list, so the callsite's layout
    // (`flex: none` and any spacing) is exactly what it was.
    expect(container!.nextElementSibling).toBe(mark)
    expect(container!.className.split(' ')).toEqual(expect.arrayContaining(['matrix', 'triggerDot']))
    expect(container!.getAttribute('aria-hidden')).toBe('true')
    // And the row around it was not disturbed: the label is still its sibling.
    expect(document.querySelector('.count')?.textContent).toBe('2')
    expect(container!.querySelector('svg')?.getAttribute('width')).toBe(String(DOT_FACE_MIN_PX))
  })

  it('draws at the smallest edge the character reads at, capped, whatever the dot measured', () => {
    const at = (width: string | null): HTMLElement => {
      const dot = document.createElement('div')
      dot.innerHTML = `<svg data-state="ongoing"${width === null ? '' : ` width="${width}"`}></svg>`
      return dot.firstElementChild as HTMLElement
    }
    // The two sizes upstream actually draws (the plugin manager's rows pass 8).
    expect(faceEdgeFor(at('8'))).toBe(DOT_FACE_MIN_PX)
    expect(faceEdgeFor(at('10'))).toBe(DOT_FACE_MIN_PX)
    // A callsite that asks for a larger mark is honoured, up to the guard.
    expect(faceEdgeFor(at('18'))).toBe(18)
    expect(faceEdgeFor(at('24'))).toBe(DOT_FACE_MAX_PX)
    // No declared size: `StateDot`'s own default, then the same floor.
    expect(faceEdgeFor(at(null))).toBe(DOT_FACE_MIN_PX)
  })

  it('releases the character when the mark goes away, and only once', async () => {
    await setup(TRIGGER)
    const mark = dot()
    expect(face()).not.toBeNull()
    // React unmounting the mark: `liveCount` fell to zero, or the turn settled.
    act(() => { mark.remove() })
    await pump()
    expect(face()).toBeNull()
    expect(document.querySelectorAll(`[${DOT_ATTR}]`)).toHaveLength(0)
  })

  it('mounts one character per dot however many scans run', async () => {
    await setup(TRIGGER)
    await pump()
    await pump()
    expect(document.querySelectorAll(`[${DOT_FACE_ATTR}]`)).toHaveLength(1)
  })

  it('leaves a settled mark alone', async () => {
    // The other four states are outcome colours, not animations: a static disc with
    // no cells to chase. Replacing those would say "working" where upstream says
    // "done", which is the one thing this seat must not do.
    await setup('<span data-state="done" class="dot"></span><svg data-state="ongoing" width="8" height="8"></svg>')
    expect(face()).not.toBeNull()
    expect(document.querySelectorAll(`[${DOT_FACE_ATTR}]`)).toHaveLength(1)
    expect(document.querySelector('span[data-state="done"]')?.getAttribute(DOT_ATTR)).toBeNull()
  })

  it('draws the pose the session facts call for', async () => {
    await setup(TRIGGER)
    expect(face()!.querySelector('svg')?.getAttribute('data-fcg-state')).toBe('thinking')
  })
})

describe('companion dot: the surface it speaks for', () => {
  it('takes the dot in the session header, which publishes no marker on itself', async () => {
    await setupOutside(HEADER)
    const mark = dot()
    expect(face()).not.toBeNull()
    expect(mark.getAttribute(DOT_ATTR)).toBe('true')
    expect(face()!.nextElementSibling).toBe(mark)
    expect(face()!.closest('.actions')).not.toBeNull()
  })

  it('takes the dot in the conversation body, without the chat column around it', async () => {
    // Each anchor is a surface of its own: the body wraps the transcript, the
    // composer and the queue, and a layout that moved the scrollport out of it would
    // still be the conversation.
    await setupOutside(`<div data-conversation-scroll="">${TRIGGER}</div>`)
    expect(face()).not.toBeNull()
    document.body.innerHTML = ''
    await setupOutside(`<div data-conversation-content=""><div class="composer" data-composer-seat="">${TRIGGER}</div></div>`)
    expect(face()).not.toBeNull()
  })

  it('leaves a settings page\u2019s dot alone, header or not', async () => {
    // A package loading is not the agent working, so the character has nothing to
    // say there and upstream's own dot stands. The page's `<header>` is deliberately
    // in the fixture: the session header is recognised by the slots it holds, and a
    // page header holds none of them.
    await setupOutside(SETTINGS_PAGE)
    for (const mark of document.querySelectorAll<HTMLElement>(ONGOING_DOT_SELECTOR)) {
      expect(mark.getAttribute(DOT_ATTR)).toBeNull()
      expect(mark.isConnected).toBe(true)
    }
    // Two marks in the fixture, so this cannot pass by finding none of them.
    expect(document.querySelectorAll(ONGOING_DOT_SELECTOR)).toHaveLength(2)
    expect(face()).toBeNull()
  })

  it('leaves a dot outside every anchor alone', async () => {
    await setupOutside(`<div class="floating">${TRIGGER}</div>`)
    expect(face()).toBeNull()
    expect(dot().getAttribute(DOT_ATTR)).toBeNull()
    // The predicate is the seat's scope, so it is asserted directly as well: the
    // row seat asks this same function, and a second implementation of the scope
    // is what would let the two seats disagree.
    expect(inConversationSurface(document.querySelector('.floating')!)).toBe(false)
    expect(inConversationSurface(document.querySelector('.floating button')!)).toBe(false)
  })
})

describe('companion dot: the upstream mark this was measured from', () => {
  /** Read a file out of the synced upstream client. */
  function upstream(relative: string): string {
    return readFileSync(resolve(nodeProcess.cwd(), 'packages/client', relative), 'utf8')
  }

  it('is the only svg StateDot emits, and only for the ongoing state', () => {
    const source = upstream('ui-primitives/src/StateDot.tsx')
    // The ongoing branch is the svg; every other state falls through to the span. The
    // selector is scoped to `svg`, so widening the state set cannot capture them.
    expect(source).toContain("if (state === 'ongoing')")
    expect(source).toContain('data-state="ongoing"')
    expect(source).toContain('data-state={state}')
    expect(ONGOING_DOT_SELECTOR).toBe('svg[data-state="ongoing"]')
  })

  it('animates the cells, which is the loading animation being replaced', () => {
    const css = upstream('ui-primitives/src/StateDot.module.css')
    expect(css).toContain('.cell {')
    expect(css).toContain('animation: dsh-state-dot-chase')
    expect(css).toContain('@keyframes dsh-state-dot-chase')
  })

  it('scopes itself by anchors the shell publishes, not by page shape', () => {
    // The seat's reach is these attributes; if the shell renames one, the surface
    // silently shrinks to whatever still matches — so the names are pinned here.
    expect(CONVERSATION_SURFACE).toBe('[data-conversation-content], [data-conversation-scroll], [data-chat-flow]')
    expect(upstream('ui-conversation/src/client/skeleton/ConversationContent.tsx')).toContain('data-conversation-content=""')
    expect(upstream('ui-conversation/src/client/skeleton/ConversationContent.tsx')).toContain('data-conversation-scroll=""')
    expect(upstream('ui-chat/src/client/chat/ChatView.tsx')).toContain('data-chat-flow=""')
    // The header publishes no marker on itself, so the seat recognises it by the
    // slots inside it — which is what keeps a settings page's `<header>` out.
    const session = upstream('ui-conversation/src/client/skeleton/ConversationSession.tsx')
    expect(session).toContain('data-conversation-header-leading=""')
    expect(session).toContain('data-conversation-header-corner=""')
    expect(session).toContain('<header className=')
  })

  it('is what a running present row shows, with the state on a wrapper', () => {
    // The pair the two seats split: the row reports `running` on a wrapper and shows
    // the ongoing dot as its own mark, so the character goes in the dot's slot and the
    // row seat stays out of it.
    const source = upstream('ui-deliverables/src/client/PresentRow.tsx')
    expect(source).toContain('data-state={state}')
    expect(source).toContain("state === 'running' ? 'ongoing'")
  })
})
