// @vitest-environment jsdom
/**
 * The companion's colour identity.
 *
 * Why this file exists
 * --------------------
 * The character's body and eye colours used to be written down in three seats
 * that never read each other — two named constants in `bar.tsx`, the same two
 * `var(...)` strings spelled inline in `companion.tsx`, and a third pair in
 * `store-face.tsx`. Nothing tied them together, and no test read any of them, so
 * the three could disagree about what colour the character is and every suite
 * would stay green. `./palette.ts` is the one declaration now, and this file is
 * what makes "one declaration" true rather than merely tidy:
 *
 *  - **The identity is fixed.** The body and the eyes are literals. A theme token
 *    there is the regression, because a body that follows `--fcg-text-primary` is
 *    a *different character* under `body[data-ds-dark-theme]` — dark-on-light
 *    inverts to light-on-dark, which is the material the resting pose must not be
 *    drawn in.
 *  - **The colours are the engine's own.** Both come from the vendored engine's
 *    colour table, so they cannot drift from the poses that were measured against
 *    that palette. Asserting the *table* rather than the hex is the point: the
 *    hexes are read out of `skins.ts` here, so moving the palette is a failing
 *    test rather than a value nobody notices.
 *  - **The split the renderer gained is real.** `paper` was two facts at once —
 *    the eyes, and the surface a particle's depth haze recedes into. Those now
 *    point opposite ways (fixed vs theme-following), so the eyes moved to `eye`
 *    and `paper` kept the haze. Both directions are asserted here, because a split
 *    that silently stopped being applied would leave the eyes following the theme
 *    again while every other test stayed green.
 *  - **The seats name a palette value, not a literal of their own.** The scan at
 *    the bottom is the guard against the three-copies failure coming back.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
// Imported rather than read off the global: the client ambient `process` is the
// build-time subset (`env` only), so `process.cwd()` is not part of this shape.
import nodeProcess from 'node:process'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CompanionSvg, dotFill } from '../src/client/companion/render.tsx'
import {
  COMPANION_BODY,
  COMPANION_EYES,
  COMPANION_HALO,
  COMPANION_SURFACE,
} from '../src/client/companion/palette.ts'
import { COLORS } from '../src/client/companion/engine/skins.ts'
import type { BotFrame } from '../src/client/companion/engine/engine.ts'

afterEach(() => { cleanup() })

/** Where the three seats live, relative to the package the lane runs in. */
const COMPANION_DIR = 'packages/freecodego/harness-ui/src/client/companion'

/** The seats, and the file each one draws from. */
const SEAT_FILES = ['bar.tsx', 'companion.tsx', 'store-face.tsx'] as const

/** The renderer's own prop names, i.e. the four a seat can colour the drawing with. */
const COLOUR_PROPS = ['ink', 'eye', 'paper', 'halo'] as const

/** The engine's own colour table, which is where the palette says it comes from. */
function engineColour(id: string): string {
  const found = COLORS.find(colour => colour.id === id)
  if (found === undefined) throw new Error(`the engine's colour table has no \`${id}\``)
  return found.hex
}

/** A frame carrying the two things the split is about: eyes, and one hazed particle. */
function frame(over: Partial<BotFrame> = {}): BotFrame {
  return {
    bodyPath: 'M -10 -10 L 10 -10 L 10 10 L -10 10 Z',
    bodyAlpha: 1,
    eyes: [{ d: 'M 0 0 L 1 1', matrix: 'matrix(1 0 0 1 2 3)', alpha: 1 }],
    dots: [{ x: 0, y: 0, r: 1, opacity: 1, depth: 0.5 }],
    dotsBehind: false,
    arcs: [],
    notif: null,
    notch: null,
    ...over,
  }
}

/** The opaque backing painted at the silhouette — what shows through the eye holes. */
function backing(container: HTMLElement): SVGPathElement {
  // Fourth `g`: back rings, behind-particles, the body, front particles.
  return container.querySelectorAll('svg > g')[2]!.querySelector('path') as SVGPathElement
}

/** The one particle the fixture carries, as it reached the DOM. */
function particle(container: HTMLElement): SVGElement {
  return container.querySelectorAll('svg > g')[3]!.querySelector('circle') as SVGElement
}

describe('the palette is an identity, not a theme', () => {
  it('declares the body and the eyes as literals, never as theme tokens', () => {
    for (const colour of [COMPANION_BODY, COMPANION_EYES]) {
      expect(colour).toMatch(/^#[0-9a-f]{6}$/i)
      expect(colour).not.toContain('var(')
    }
    // Named, not just "no token": these are the two that used to make the
    // character flip with the page, and a future edit reaching for either is the
    // exact regression this file exists for.
    for (const token of ['--fcg-text-primary', '--fcg-bg-base']) {
      expect(COMPANION_BODY).not.toContain(token)
      expect(COMPANION_EYES).not.toContain(token)
    }
  })

  it('takes both values from the engine\u2019s own colour table', () => {
    // `encre` is the palette the drawing was authored against, and `creme` is the
    // light end of the same table. Asserting the table rather than a literal is
    // what keeps the character from drifting away from the poses measured against
    // that palette: a new hex here has to be a new row there first.
    expect(COMPANION_BODY).toBe(engineColour('encre'))
    expect(COMPANION_EYES).toBe(engineColour('creme'))
  })

  it('keeps the surface and the halo the only theme-following halves', () => {
    // The haze is the page a particle falls back into, so it has to follow the
    // page; the halo is the dark-theme compensation for a fixed black body, so it
    // follows the theme while the character does not. Both go through the token
    // layer, which is what makes them one value to tune rather than two.
    expect(COMPANION_SURFACE).toContain('var(--fcg-bg-base')
    expect(COMPANION_HALO).toContain('var(--fcg-companion-halo')
  })
})

describe('the renderer separates the eyes from the haze surface', () => {
  it('paints the eyes with `eye` and hazes particles towards `paper`', () => {
    const rendered = render(
      <CompanionSvg frame={frame()} size={24} ink="#000000" eye="#f1efe9" paper="#ffffff" />,
    )
    // jsdom normalises a colour written into a style declaration.
    expect(backing(rendered.container).style.fill).toBe('rgb(241, 239, 233)')
    // The particle still recedes into the *page*, not into the eyes: at depth 0.5
    // that is the midpoint of white and black, and it would be a different value
    // if the split had left both props pointing at the same colour.
    expect(particle(rendered.container).style.fill).toBe('rgb(128, 128, 128)')
  })

  it('falls back to `paper` for the eyes when no `eye` is given', () => {
    const rendered = render(<CompanionSvg frame={frame()} size={24} ink="#000000" paper="#ffffff" />)
    // The behaviour a caller with no reason to distinguish the two keeps: the eyes
    // are whatever is behind the body, as they were before the split.
    expect(backing(rendered.container).style.fill).toBe('rgb(255, 255, 255)')
  })

  it('hazes towards the surface and not towards the eyes, exactly', () => {
    // Asserted through the seam as well as the DOM, so the contract is stated once
    // where it is decided. The eyes are not an argument to the haze at all.
    expect(dotFill(undefined, 0.5, '#000000', '#ffffff')).toBe('#808080')
    expect(dotFill(undefined, 0, '#000000', '#ffffff')).toBe('#ffffff')
  })

  it('applies the halo to the drawn body alone', () => {
    const halo = 'drop-shadow(0 0 1px rgba(255, 255, 255, 0.45))'
    const rendered = render(<CompanionSvg frame={frame()} size={24} halo={halo} />)
    const groups = rendered.container.querySelectorAll('svg > g')
    const body = groups[2] as SVGElement
    expect(body.style.filter).toContain('drop-shadow')
    // Not the rings, and not the confetti: a halo around a burst would outline
    // every speck, and a halo on the rings would read as an edge rather than light.
    for (const index of [0, 1, 3, 4]) {
      expect((groups[index] as SVGElement).style.filter).toBe('')
    }
  })

  it('leaves the body untouched when no halo is given', () => {
    const rendered = render(<CompanionSvg frame={frame()} size={24} />)
    // Nothing about the light-theme drawing changes because the prop exists.
    const body = rendered.container.querySelectorAll('svg > g')[2] as SVGElement
    expect(body.style.filter).toBe('')
    expect(body.getAttribute('style')).toBeNull()
  })
})

describe('the seats take their colour from the palette', () => {
  it('names a palette value for every colour it hands the renderer, and none of its own', () => {
    // The three-copies regression, stated as a scan: a seat may only colour the
    // drawing by naming one of the palette's constants, so a literal (or a token)
    // written into a seat fails here instead of waiting to be found by whichever
    // seat it was not copied into. Same shape as the fence check in
    // `tool-manifest.spec.ts` — a module whose job is to *consume* a table has no
    // values of its own.
    const seen: string[] = []
    for (const file of SEAT_FILES) {
      const source = readFileSync(resolve(nodeProcess.cwd(), COMPANION_DIR, file), 'utf8')
      for (const match of source.matchAll(/\b(ink|eye|paper|halo)=\{([^}]*)\}/gu)) {
        const [, prop, value] = match
        expect(COLOUR_PROPS, `${file} colours the drawing with an unknown prop`).toContain(prop)
        expect(value, `${file} hands \`${prop}\` a value of its own`).toMatch(/^COMPANION_[A-Z]+$/)
        seen.push(`${file}:${prop}`)
      }
    }
    // Non-vacuous: four props on each of the three seats. A seat that stopped
    // colouring the drawing at all would otherwise pass this file silently.
    expect(seen).toHaveLength(SEAT_FILES.length * COLOUR_PROPS.length)
    expect(new Set(seen).size).toBe(seen.length)
  })
})
