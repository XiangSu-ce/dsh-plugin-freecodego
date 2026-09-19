// @vitest-environment jsdom
/**
 * The renderer's decor slots: how many rings, particles, and eyes it mounts.
 *
 * The renderer mounts a floor's worth of empty slots and drives the surplus to
 * opacity 0, so the ordinary pose change does not remount a path mid-animation.
 * Two properties of that scheme are worth a spec of their own, because both fail
 * silently:
 *
 * - **The floor is a floor, not a ceiling.** A frame carrying more decor than the
 *   floor must still be drawn in full. Truncating would drop a ring with no error
 *   anywhere — the picture would simply be subtly wrong.
 * - **The floor is high enough.** It was chosen from the engine's own measured
 *   worst case, and the engine's bound is not obvious: `setState` during a morph
 *   freezes the *composite* pose, which may itself hold an earlier freeze, so the
 *   count is a chain rather than "two poses' worth". If a future edit to the
 *   engine raises the real maximum, this spec fails rather than the ring vanishing
 *   in a corner of a morph nobody looks at.
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CompanionSvg } from '../src/client/companion/render.tsx'
import { BotEngine } from '../src/client/companion/engine/engine.ts'
import { RAYON } from '../src/client/companion/engine/repere.ts'
import type { BotFrame } from '../src/client/companion/engine/engine.ts'
import type { StateId } from '../src/client/companion/engine/states.ts'

afterEach(cleanup)

/** The floor the renderer mounts for a frame that asks for little. */
const ARC_FLOOR = 12
/** Particles mounted for a frame that asks for little. */
const DOT_FLOOR = 8
/** Eyes mounted for a frame that asks for little. */
const EYE_FLOOR = 2

/** A frame carrying nothing but what a case passes in. */
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

/** `n` rings, each with a two-stop gradient. */
function arcs(n: number): BotFrame['arcs'] {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    front: `M 0 ${i} L 1 1`,
    back: `M 2 ${i} L 3 3`,
    width: 4,
    opacity: 0.5,
    grad: { x1: 1, y1: 2, x2: 3, y2: 4, stops: ['#111111', '#222222'] },
  }))
}

/** `n` eyes. */
function eyes(n: number): BotFrame['eyes'] {
  return Array.from({ length: n }, (_, i) => ({ d: `M ${i} 0 L 1 1`, matrix: `matrix(1 0 0 1 ${i} 0)`, alpha: 0.9 }))
}

/** `n` round particles. */
function dots(n: number): BotFrame['dots'] {
  return Array.from({ length: n }, (_, i) => ({ x: i, y: i, r: 1, opacity: 1 }))
}

/** Every state the engine defines, in the order the catalogue lists them. */
const ALL_STATES: StateId[] = [
  'idle', 'thinking', 'wink', 'wide', 'alert', 'notify', 'exclaim', 'sleep',
  'egg', 'hexagon', 'play', 'orbit', 'burst', 'comet', 'swirl',
]

describe('companion renderer: the decor slots', () => {
  it('mounts the floor, keyed by index, so a pose change reuses every element', () => {
    const wide = render(<CompanionSvg frame={frame({ arcs: arcs(1), dots: dots(1), eyes: eyes(2) })} size={24} />)
    const slotted = wide.container.querySelectorAll('linearGradient')
    expect(slotted).toHaveLength(ARC_FLOOR)
    const front = wide.container.querySelectorAll('svg > g')[3]!.querySelectorAll('circle, path')
    expect(front).toHaveLength(DOT_FLOOR)
    expect(wide.container.querySelectorAll('mask path')).toHaveLength(1 + EYE_FLOOR)

    // A frame with nothing at all still mounts the same elements: the count is a
    // property of the renderer, not of the pose, which is what keeps a change from
    // remounting a path halfway through its animation.
    const bare = render(<CompanionSvg frame={frame()} size={24} />)
    expect(bare.container.querySelectorAll('linearGradient')).toHaveLength(ARC_FLOOR)
    expect(bare.container.querySelectorAll('mask path')).toHaveLength(1 + EYE_FLOOR)
  })

  it('draws a frame in full when it carries more decor than the floor', () => {
    const many = render(
      <CompanionSvg frame={frame({ arcs: arcs(ARC_FLOOR + 3), dots: dots(DOT_FLOOR + 2), eyes: eyes(EYE_FLOOR + 1) })} size={24} />,
    )
    // The last ring is the case that matters: a truncating renderer would drop it
    // and nothing else in the picture would look wrong.
    const gradients = many.container.querySelectorAll('linearGradient')
    expect(gradients).toHaveLength(ARC_FLOOR + 3)
    const back = many.container.querySelectorAll('g[fill="none"]')[0]!.querySelectorAll('path')
    expect(back).toHaveLength(ARC_FLOOR + 3)
    expect(back[ARC_FLOOR + 2]!.getAttribute('d')).toBe('M 2 14 L 3 3')
    const front = many.container.querySelectorAll('g[fill="none"]')[1]!.querySelectorAll('path')
    expect(front[ARC_FLOOR + 2]!.getAttribute('d')).toBe('M 0 14 L 1 1')
    // One gradient definition per mounted ring, so a ring past the floor still has
    // a paint source rather than a dangling `url(#...)`.
    expect(many.container.querySelectorAll('g[fill="none"]')[0]!.querySelectorAll('path')[ARC_FLOOR + 2]!.getAttribute('stroke'))
      .toBe(`url(#${gradients[ARC_FLOOR + 2]!.getAttribute('id')})`)
    expect(many.container.querySelectorAll('svg > g')[3]!.querySelectorAll('circle')).toHaveLength(DOT_FLOOR + 2)
    expect(many.container.querySelectorAll('mask path')).toHaveLength(1 + EYE_FLOOR + 1)
  })

  it('leaves the floor high enough for the engine, over a hostile chain of changes', () => {
    // The chain that reaches the engine's maximum: each change lands inside the
    // previous morph, so each freeze stacks on the last.
    const heavy: StateId[] = ['orbit', 'comet', 'hexagon', 'egg', 'burst', 'play', 'alert']
    const engine = new BotEngine(RAYON, 'orbit')
    let maxArcs = 0
    let maxDots = 0
    let maxEyes = 0
    for (const start of ALL_STATES) {
      for (const gap of [0.02, 0.05, 0.1, 0.25, 0.4]) {
        engine.reset(start, 0)
        engine.sample(3)
        let at = 3.05
        for (const step of heavy) {
          engine.setState(step, at)
          at += gap
        }
        for (let t = 3; t <= at + 1; t += 0.01) {
          const sampled = engine.sample(t)
          maxArcs = Math.max(maxArcs, sampled.arcs.length)
          maxDots = Math.max(maxDots, sampled.dots.length)
          maxEyes = Math.max(maxEyes, sampled.eyes.length)
        }
      }
    }
    // Measured, not assumed: this is the figure the renderer's floor is sized
    // from, and raising it is the signal to raise the floor with it.
    expect(maxArcs).toBeLessThanOrEqual(ARC_FLOOR)
    expect(maxDots).toBeLessThanOrEqual(DOT_FLOOR)
    expect(maxEyes).toBeLessThanOrEqual(EYE_FLOOR)
    // A floor nobody reaches would be dead weight; a real maximum proves the
    // search above actually exercised a blend rather than a single pose.
    expect(maxArcs).toBeGreaterThan(6)
  })
})
