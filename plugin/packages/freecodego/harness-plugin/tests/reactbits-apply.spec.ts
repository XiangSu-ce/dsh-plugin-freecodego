/**
 * Planning a write, before anything is written.
 *
 * Two things this file is really about. **The alterations are knowable in advance:**
 * the planner is pure, so what a write would change is a value that can be asserted
 * on, shown to a caller, and diffed — which is what makes the confirmation step
 * meaningful rather than ceremonial. And **the bounded-motion block is written as a
 * duration, not as a removal:** an entrance animation that starts at `opacity: 0`
 * leaves the content invisible if it is deleted, so a patch that removed motion
 * would hide the page it was meant to make calmer. That case is asserted directly.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/reactbits-apply
 */

import { describe, expect, it } from 'vitest'

import {
  animatingSelectors,
  destinationPath,
  directoryRefusal,
  planReactBitsWrites,
  plannedNamesAreSafe,
  reducedMotionBlock,
  writeAsName,
} from '../src/reactbits/apply.ts'

/** A component with no directive, as upstream publishes one. */
const COMPONENT = "import { useState } from 'react'\n\nexport function Widget() { return null }\n"

/** A stylesheet that animates and ignores the system setting. */
const SHEET = [
  '.card {',
  '  opacity: 0;',
  '  animation: rise 600ms ease-out forwards;',
  '}',
  '',
  '.card__body { transition: transform 200ms ease; }',
  '',
].join('\n')

describe('the \'use client\' decision', () => {
  it('adds the directive when the framework renders on the server, and says why', () => {
    const plan = planReactBitsWrites({
      files: [{ path: 'Widget/Widget.tsx', content: COMPONENT }],
      serverRendered: true,
      directive: 'auto',
    })
    expect(plan.files[0]?.content.startsWith("'use client'\n\n")).toBe(true)
    expect(plan.files[0]?.content).toContain('export function Widget')
    expect(plan.files[0]?.transformations.map(change => change.id)).toEqual(['client-directive'])
    expect(plan.files[0]?.transformations[0]?.reason).toContain('cannot change what it renders')
    expect(plan.followUps.map(follow => follow.id)).toContain('client-directive')
  })

  it('leaves the directive out where the framework does not need it, and obeys "never"', () => {
    const clientOnly = planReactBitsWrites({ files: [{ path: 'W/W.tsx', content: COMPONENT }], serverRendered: false, directive: 'auto' })
    expect(clientOnly.files[0]?.content).toBe(COMPONENT)
    expect(clientOnly.files[0]?.transformations).toEqual([])

    const always = planReactBitsWrites({ files: [{ path: 'W/W.tsx', content: COMPONENT }], serverRendered: false, directive: 'always' })
    expect(always.files[0]?.content.startsWith("'use client'")).toBe(true)

    const never = planReactBitsWrites({ files: [{ path: 'W/W.tsx', content: COMPONENT }], serverRendered: true, directive: 'never' })
    expect(never.files[0]?.content).toBe(COMPONENT)
  })

  it('never adds a second directive to a file that has one', () => {
    const plan = planReactBitsWrites({
      files: [{ path: 'W/W.tsx', content: "'use client'\n\nimport { useState } from 'react'\n" }],
      serverRendered: true,
      directive: 'always',
    })
    expect(plan.files[0]?.content.match(/'use client'/gu)).toHaveLength(1)
    expect(plan.files[0]?.transformations).toEqual([])
  })

  it('does not touch a stylesheet with the directive rule', () => {
    const plan = planReactBitsWrites({
      files: [{ path: 'W/W.css', content: '.w { color: red }\n' }],
      serverRendered: true,
      directive: 'always',
    })
    expect(plan.files[0]?.content).toBe('.w { color: red }\n')
  })
})

describe('the bounded-motion block', () => {
  it('names the selectors that animate, and only those', () => {
    expect(animatingSelectors(SHEET)).toEqual(['.card', '.card__body'])
    // A rule that only looks like one: a comment explaining an animation, and a
    // declaration commented out.
    expect(animatingSelectors('/* .gone { animation: x 1s } */\n.plain { color: red }')).toEqual([])
    // Keyframe steps are not selectors anything can be told to slow down.
    expect(animatingSelectors('@keyframes rise { from { opacity: 0 } to { opacity: 1 } }')).toEqual([])
  })

  it('bounds the duration rather than removing the animation, so nothing stays invisible', () => {
    const block = reducedMotionBlock(SHEET)
    expect(block).toBeDefined()
    expect(block).toContain('@media (prefers-reduced-motion: reduce)')
    expect(block).toContain('.card,\n  .card__body {')
    expect(block).toContain('animation-duration: 0.01ms !important;')
    expect(block).toContain('animation-iteration-count: 1 !important;')
    expect(block).toContain('transition-duration: 0.01ms !important;')
    // The hazard this shape exists to avoid: `animation: none` would leave `.card`
    // at its first keyframe, which is `opacity: 0` — the content would be gone.
    expect(block).not.toContain('animation: none')
  })

  it('says nothing to a sheet that cannot animate, or that already handles the setting', () => {
    expect(reducedMotionBlock('.w { color: red }')).toBeUndefined()
    expect(reducedMotionBlock(`${SHEET}\n@media (prefers-reduced-motion: reduce) { .card { animation: none } }`)).toBeUndefined()
  })

  it('appends the block to a sheet and reports it, and reports JavaScript motion as manual', () => {
    const plan = planReactBitsWrites({
      files: [
        { path: 'W/W.tsx', content: "import { gsap } from 'gsap'\n\nexport function W() { gsap.to('.x', {}) }\n" },
        { path: 'W/W.css', content: SHEET },
      ],
      serverRendered: false,
      directive: 'auto',
    })
    expect(plan.files[1]?.content.trimEnd().endsWith('}')).toBe(true)
    expect(plan.files[1]?.transformations.map(change => change.id)).toEqual(['reduced-motion'])
    expect(plan.followUps.map(follow => follow.id)).toContain('reduced-motion-bounded')
    // No sheet in the item, so the JS-driven motion has no mechanical answer, and the
    // plan says so instead of writing a rule that could not reach it.
    const jsOnly = planReactBitsWrites({
      files: [{ path: 'W/W.tsx', content: "import { gsap } from 'gsap'\n\nexport function W() { gsap.to('.x', {}) }\n" }],
      serverRendered: false,
      directive: 'auto',
    })
    expect(jsOnly.followUps.map(follow => follow.id)).toContain('reduced-motion-manual')
  })

  it('leaves the sheet alone when the caller turned the patch off', () => {
    const plan = planReactBitsWrites({
      files: [{ path: 'W/W.css', content: SHEET }],
      serverRendered: false,
      directive: 'auto',
      reducedMotion: false,
    })
    expect(plan.files[0]?.content).toBe(SHEET)
    expect(plan.files[0]?.transformations).toEqual([])
  })
})

describe('the path policy', () => {
  it('refuses an absolute destination and any climb out of the working directory', () => {
    expect(directoryRefusal('src/components', 'C:/work/app')).toBeUndefined()
    expect(directoryRefusal('', 'C:/work/app')).toContain('empty')
    expect(directoryRefusal('C:/elsewhere', 'C:/work/app')).toContain('absolute')
    expect(directoryRefusal('/srv/app', 'C:/work/app')).toContain('absolute')
    expect(directoryRefusal('../sibling', 'C:/work/app')).toContain('climbs out')
    expect(directoryRefusal('src/../../etc', 'C:/work/app')).toContain('climbs out')
    expect(directoryRefusal('src/..', 'C:/work/app')).toContain('climbs out')
  })

  it('joins a destination without doubling a separator, on either spelling', () => {
    expect(destinationPath('C:/work/app', 'src/bits', 'Widget.tsx')).toBe('C:/work/app/src/bits/Widget.tsx')
    expect(destinationPath('C:/work/app/', '/src/bits/', 'Widget.tsx')).toBe('C:/work/app/src/bits/Widget.tsx')
    expect(destinationPath('/home/me/app', 'src\\bits', 'Widget.tsx')).toBe('/home/me/app/src\\bits/Widget.tsx')
  })

  it('takes the file name from the path\\u2019s own last segment, and refuses a name that carries one', () => {
    expect(writeAsName('CountUp/CountUp.tsx')).toBe('CountUp.tsx')
    expect(writeAsName('CountUp.tsx')).toBe('CountUp.tsx')
    const safe = planReactBitsWrites({ files: [{ path: 'A/B.tsx', content: COMPONENT }], serverRendered: false, directive: 'auto' })
    expect(plannedNamesAreSafe(safe.files)).toBe(true)
  })
})
